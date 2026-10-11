#!/usr/bin/env python3
"""Repository gates. Findings are summarized without source or secret values."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def command(args, cwd):
    return subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def git(args):
    result = command(['git'] + args, ROOT)
    if result.returncode:
        raise RuntimeError('Git index could not be read')
    return result.stdout


def audit_key(name, item, lock):
    # Pin every affected installed version and advisory chain, not just its name.
    value = {'package': name, 'severity': item['severity'],
             'range': item.get('range'), 'via': item.get('via', []),
             'installed': {p: lock.get('packages', {}).get(p, {}).get('version')
                           for p in item.get('nodes', [])}}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def code_key(result, root):
    p = Path(result['path'])
    if p.is_absolute():
        p = p.relative_to(root)
    lines = (root / p).read_bytes().splitlines(keepends=True)
    block = b''.join(lines[result['start']['line'] - 1:result['end']['line']])
    return {'rule': result['check_id'].split('.')[-1], 'file': p.as_posix(),
            'sha256': hashlib.sha256(block).hexdigest(),
            'source_sha256': hashlib.sha256((root / p).read_bytes()).hexdigest(),
            'line': result['start']['line'], 'column': result['start']['col']}


def exceptions(policy, kind):
    today = datetime.date.today()
    accepted = []
    for entry in policy.get(kind, []):
        if not entry.get('reason') or not entry.get('tracking'):
            raise RuntimeError('Security exception lacks its reason or remediation tracking')
        if datetime.date.fromisoformat(entry['expires']) < today:
            raise RuntimeError('A documented security exception expired; remediate or review it')
        accepted.append(entry)
    return accepted


def audit(root, policy):
    result = command(['npm', 'audit', '--omit=dev', '--audit-level=high', '--json'], root)
    data = json.loads(result.stdout)
    if data.get('error') or result.returncode not in (0, 1) or 'vulnerabilities' not in data:
        raise RuntimeError('npm audit could not complete; check registry connectivity')
    lock = json.loads((root / 'package-lock.json').read_text())
    accepted = exceptions(policy, 'audit')
    blocked = 0
    for name, item in data['vulnerabilities'].items():
        if item['severity'] not in ('high', 'critical'):
            continue
        key = audit_key(name, item, lock)
        known = any(x['package'] == name and x['sha256'] == key for x in accepted)
        print('npm audit: %s %s (%s)' % (name, item['severity'],
              'documented existing finding; see .security/FINDINGS.md' if known else 'BLOCKED'))
        if not known:
            blocked += 1
    if blocked:
        raise RuntimeError('New or changed high/critical dependency findings block this gate')
    print('npm audit gate PASS (production dependencies; high threshold)')


def semgrep(root, policy, targets=None):
    if not shutil.which('semgrep'):
        raise RuntimeError('Semgrep missing; install the repository pin before retrying')
    args = ['semgrep', 'scan', '--config', '.security/semgrep.yml', '--error',
            '--strict', '--metrics', 'off', '--disable-version-check', '--disable-nosem',
            '--max-target-bytes', '0', '--timeout', '0', '--json']
    # Explicit staged targets avoid scanning an unstaged worktree or unrelated files.
    if targets is not None and not targets:
        print('Semgrep: no staged source files')
        return
    args += ['--'] + (targets if targets is not None else ['.'])
    result = command(args, root)
    data = json.loads(result.stdout)
    if result.returncode not in (0, 1) or data.get('errors'):
        raise RuntimeError('Semgrep could not complete cleanly; no partial scan is accepted')
    accepted = exceptions(policy, 'semgrep')
    blocked = 0
    for finding in data.get('results', []):
        key = code_key(finding, root)
        known = any(all(x.get(k) == v for k, v in key.items()) for x in accepted)
        print('Semgrep: %s:%s %s (%s)' % (key['file'], finding['start']['line'], key['rule'],
              'documented existing finding; see .security/FINDINGS.md' if known else 'BLOCKED'))
        if not known:
            blocked += 1
    if blocked:
        raise RuntimeError('New or changed code findings block this gate')
    print('Semgrep gate PASS (offline local rules; metrics disabled)')


def policy(root):
    return json.loads((root / '.security/policy.json').read_text())


def normalize_parser(root):
    # Semgrep 1.180.0 misparses this valid TS regex as an HTML comment.
    # Rewrite only its spelling in the disposable scan copy, with identical
    # pattern and flags. Runtime/index bytes are never modified.
    p = root / 'src/core/sonos.ts'
    if p.exists():
        text = p.read_text()
        old = r'/<!--\s*SDT:[^>]*-->/g'
        new = r'new RegExp("<!--\\s*SDT:[^>]*-->", "g")'
        p.write_text(text.replace(old, new))


def full():
    with tempfile.TemporaryDirectory(prefix='repo-security-') as directory:
        snapshot = Path(directory)
        names = git(['ls-files', '-co', '--exclude-standard', '-z']).split(b'\0')
        for raw in dict.fromkeys(names):
            if not raw:
                continue
            name = os.fsdecode(raw)
            source = ROOT / name
            if source.is_file() and not source.is_symlink():
                target = snapshot / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        reviewed = policy(snapshot)
        audit(snapshot, reviewed)
        normalize_parser(snapshot)
        semgrep(snapshot, reviewed)


def staged():
    changed = [os.fsdecode(p) for p in git(['diff', '--cached', '--name-only',
                                         '--diff-filter=ACMR', '-z']).split(b'\0') if p]
    with tempfile.TemporaryDirectory(prefix='repo-security-') as directory:
        snapshot = Path(directory)
        # Use the index for tools, configuration, package metadata and candidate source.
        required = ['.semgrepignore', 'package.json', 'package-lock.json']
        tooling = [os.fsdecode(p) for p in git(['ls-files', '-z', '.security']).split(b'\0') if p]
        for name in dict.fromkeys(changed + required + tooling):
            path = Path(name)
            if path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unsafe staged path')
            entries = git(['ls-files', '--stage', '-z', '--', name]).split(b'\0')
            entries = [x for x in entries if x]
            if not entries:
                continue
            mode, oid, stage = entries[0].split(b'\t', 1)[0].split()
            if stage != b'0' or mode not in (b'100644', b'100755'):
                if name in required + tooling:
                    raise RuntimeError('Security files must be regular index files')
                continue
            target = snapshot / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(['cat-file', 'blob', oid.decode()]))
        reviewed = policy(snapshot)
        if any(x in changed for x in ['package.json', 'package-lock.json', '.security/policy.json']):
            audit(snapshot, reviewed)
        # Include tests and scripts; only generated/vendor paths are ignored.
        targets = [x for x in changed if (snapshot / x).is_file()
                   and Path(x).suffix in ('.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py')]
        normalize_parser(snapshot)
        semgrep(snapshot, reviewed, targets)


def main():
    os.chdir(ROOT)
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if mode == 'staged':
        staged()
    elif mode == 'all':
        full()
    else:
        raise RuntimeError('Use all or staged')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, IndexError):
        # Do not echo arbitrary tool errors, source snippets, private paths or config.
        print('Security gate BLOCKED: finding, expired policy, missing tool, or incomplete scan. '
              'Review masked findings above and .security/FINDINGS.md; rerun after repair.', file=sys.stderr)
        sys.exit(1)
