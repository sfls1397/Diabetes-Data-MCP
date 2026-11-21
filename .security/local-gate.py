#!/usr/bin/env python3
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

CONTEXT = 'local-gate'
ROOT = Path(__file__).resolve().parent.parent
PINS = {'gitleaks': ('.cursor/install-gitleaks.sh', ['gitleaks', 'version']),
        'semgrep': ('.cursor/install-semgrep.sh', ['semgrep', '--version']),
        'shellcheck': ('.cursor/install-shellcheck.sh', ['shellcheck', '--version'])}
STANDARD = [
    ('Git metadata (raw author/committer, messages)', ['python3', '.security/metadata.py', 'history', 'HEAD']),
    ('Gitleaks full history', ['gitleaks', 'git', '--log-opts=HEAD', '--config', '.gitleaks.toml',
                               '--redact=100', '--no-banner', '.']),
    ('Pre-commit hook', ['.githooks/pre-commit']),
    ('npm audit (production, high) + offline Semgrep + ShellCheck/Clang', ['python3', '.security/scan.py', 'all']),
    ('Gate enforcement probes', ['python3', '.security/test_gates.py']),
    ('Repository standard probes', ['python3', '.security/test_standard.py']),
]

LINT = ('Types and strict lint (tsc, ESLint, Ruff, Pyright, imports, comments)', ['python3', '.security/lint.py', 'gate'])

GATE_WARNING = re.compile(r'^gate-warning: (.+)$', re.M)
MAX_WARNINGS = 10
MAX_WARNING_TEXT = 400


class GateError(Exception):
    pass


def out(args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise GateError('Command failed: ' + ' '.join(args[:3]))
    return result.stdout.strip()


def gh(args):
    return json.loads(out(['gh'] + args))


def pin(script):
    match = re.search(r"""^version=['"]?([0-9][0-9.]*)""", (ROOT / script).read_text(), re.M)
    if not match:
        raise GateError('No version pin in ' + script)
    return match.group(1)


def tools(env):
    found = {}
    for name, (script, args) in PINS.items():
        if not (ROOT / script).exists():
            continue
        wanted = pin(script)
        result = subprocess.run(args, capture_output=True, text=True, env=env)
        version = re.search(r'([0-9]+\.[0-9]+\.[0-9]+)', result.stdout or '')
        if result.returncode or not version or version.group(1) != wanted:
            raise GateError('%s is not the pinned %s; run the repository installer' % (name, wanted))
        found[name] = wanted
    return found


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12] if path.exists() else 'none'


def steps(tree):
    config = tree / '.security/local-gate.json'
    tests = json.loads(config.read_text()).get('tests', []) if config.exists() else []
    for args in tests:
        if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args):
            raise GateError('local-gate.json tests must be argument lists')
    ordered = []
    for args in tests:
        ordered.append(('Tests: ' + ' '.join(args), args))
        if args == ['npm', 'ci']:
            ordered.append(LINT)
    if LINT not in ordered:
        ordered.insert(0, LINT)
    return STANDARD + ordered


def warning_lines(text):
    warnings = [line.strip()[:MAX_WARNING_TEXT] for line in GATE_WARNING.findall(text) if line.strip()]
    lines = ['      warning (not blocking): ' + line for line in warnings[:MAX_WARNINGS]]
    if len(warnings) > MAX_WARNINGS:
        lines.append('      ... and %d more warnings' % (len(warnings) - MAX_WARNINGS))
    return lines


def run_gate(sha, logdir, env):
    results = []
    tree = Path(tempfile.mkdtemp(prefix='local-gate-')) / 'tree'
    out(['git', 'worktree', 'add', '--detach', '--quiet', str(tree), sha])
    try:
        if out(['git', 'config', 'core.hooksPath'], tree) != '.githooks':
            raise GateError('core.hooksPath must be .githooks')
        for hook in ['pre-commit', 'commit-msg', 'pre-push']:
            if not os.access(tree / '.githooks' / hook, os.X_OK):
                raise GateError('Hook missing or not executable: ' + hook)
        versions = tools(env)
        results.append(('Hooks enabled; pinned scanners ' + ', '.join(
            '%s %s' % kv for kv in sorted(versions.items())), True, 0))
        for number, (name, args) in enumerate(steps(tree), 1):
            log = logdir / ('%02d.log' % number)
            started = time.time()
            with log.open('wb') as handle:
                code = subprocess.run(args, cwd=tree, stdout=handle, stderr=subprocess.STDOUT, env=env).returncode
            seconds = int(time.time() - started)
            results.append((name, code == 0, seconds))
            print('%-4s %5ss  %s' % ('PASS' if code == 0 else 'FAIL', seconds, name))
            for line in warning_lines(log.read_text(errors='replace')):
                print(line)
            if code:
                print('--- local output (not sent to GitHub): ' + str(log))
                print(''.join(log.read_text(errors='replace').splitlines(True)[-40:]))
                break
        return results, digest(tree / '.security/local-gate.py'), digest(tree / '.security/local-gate.json')
    finally:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(tree)], cwd=ROOT, capture_output=True)
        shutil.rmtree(tree.parent, ignore_errors=True)


def record(repo, sha, number, results, hashes):
    passed = bool(results) and all(ok for _, ok, _ in results)
    total = sum(s for _, _, s in results)
    description = ('PASS' if passed else 'FAIL') + ': gitleaks, npm audit (high), semgrep, probes, tests (%ss)' % total
    out(['gh', 'api', '-X', 'POST', 'repos/%s/statuses/%s' % (repo, sha), '-f', 'state=' + ('success' if passed else 'failure'),
         '-f', 'context=' + CONTEXT, '-f', 'description=' + description[:140]])
    if number is None:
        return passed
    when = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    lines = ['<!-- local-gate -->',
             '**Local gate %s** for head `%s` (%s %s, %s)' % ('PASS' if passed else 'FAIL', sha, platform.system(), platform.machine(), when),
             '', '| Step | Result | Time |', '| --- | --- | --- |']
    lines += ['| %s | %s | %ss |' % (name, 'PASS' if ok else '**FAIL**', s) for name, ok, s in results]
    lines += ['', 'Recorded as commit status `%s` on this exact SHA. `python3 .security/merge-pr.py %s` requires it; '
              'GitHub Actions are not the merge gate. Gate files: local-gate.py %s, local-gate.json %s.' % (CONTEXT, number, hashes[0], hashes[1])]
    body = Path(tempfile.mkstemp(prefix='local-gate-comment-')[1])
    try:
        body.write_text('\n'.join(lines) + '\n')
        out(['gh', 'pr', 'comment', str(number), '--body-file', str(body)])
    finally:
        body.unlink()
    return passed


def require_pr_head(number, local):
    for attempt in range(5):
        pr = gh(['pr', 'view', number, '--json', 'headRefOid,baseRefName,state,isDraft'])
        if pr['state'] != 'OPEN' or pr['isDraft'] or pr['baseRefName'] != 'main':
            raise GateError('PR must be open, ready, and target main')
        if local == pr['headRefOid']:
            return
        if attempt < 4:
            time.sleep(5)
    raise GateError('Check out the PR head first; the local commit is not the PR head')


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[1-9][0-9]*|deploy', sys.argv[1]):
        raise GateError('Use local-gate.py PR_NUMBER (from the reviewed PR checkout) or local-gate.py deploy')
    os.chdir(ROOT)
    env = dict(os.environ, PATH=str(Path.home() / '.local/bin') + os.pathsep + os.environ.get('PATH', ''))
    env.pop('LOCAL_GATE_BASE', None)
    repo = gh(['repo', 'view', '--json', 'nameWithOwner'])['nameWithOwner']
    local = out(['git', 'rev-parse', 'HEAD'])
    number = None
    if sys.argv[1] != 'deploy':
        number = sys.argv[1]
        require_pr_head(number, local)
        base = subprocess.run(['git', 'merge-base', 'origin/main', local], cwd=ROOT, capture_output=True, text=True)
        if not base.returncode and re.fullmatch(r'[0-9a-f]{40}', base.stdout.strip()):
            env['LOCAL_GATE_BASE'] = base.stdout.strip()
    with tempfile.TemporaryDirectory(prefix='local-gate-logs-') as logs:
        try:
            results, *hashes = run_gate(local, Path(logs), env)
        except GateError as error:
            results, hashes = [(str(error), False, 0)], ('none', 'none')
            print('FAIL  ' + str(error))
        passed = record(repo, local, number, results, hashes)
    print('Local gate %s for %s; recorded as %s status%s' % ('PASS' if passed else 'FAIL', local[:12], CONTEXT,
                                                             ' and PR #%s comment' % number if number else ''))
    return 0 if passed else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Local gate BLOCKED: %s' % error, file=sys.stderr)
        sys.exit(1)
