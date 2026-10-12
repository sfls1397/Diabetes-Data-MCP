#!/usr/bin/env python3
"""Merge only the reviewed PR head after successful trusted GitHub checks."""
import json
import re
import subprocess
import sys


def gh(args):
    result = subprocess.run(['gh'] + args, capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub request failed')
    return json.loads(result.stdout)


def checks_pass(checks, expected):
    latest = {}
    for check in checks:
        if check['name'] == 'publish-npm':
            continue  # Release-only deployment job is not a PR gate.
        if check.get('app', {}).get('slug') != 'github-actions':
            continue
        old = latest.get(check['name'])
        if old is None or check['id'] > old['id']:
            latest[check['name']] = check
    if not expected.issubset(latest):
        return False
    # All present jobs must pass too; skipping a security job is not success.
    return all(c.get('status') == 'completed' and c.get('conclusion') == 'success' for c in latest.values())


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[1-9][0-9]*', sys.argv[1]):
        raise RuntimeError('Use merge-pr.py PR_NUMBER from the reviewed checkout')
    number = sys.argv[1]
    repo = gh(['repo', 'view', '--json', 'nameWithOwner'])['nameWithOwner']
    pr = gh(['pr', 'view', number, '--json', 'headRefOid,baseRefName,state,isDraft'])
    if pr['state'] != 'OPEN' or pr['isDraft'] or pr['baseRefName'] != 'main':
        raise RuntimeError('PR must be open, ready, and target main')
    sha = pr['headRefOid']
    local = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    if local != sha:
        raise RuntimeError('The local reviewed commit is not the PR head')
    raw = gh(['api', '--paginate', '--slurp', 'repos/' + repo + '/commits/' + sha + '/check-runs?per_page=100'])
    checks = [c for page in raw for c in page['check_runs']]
    expected = {'gitleaks', 'security'}
    from pathlib import Path
    if list(Path('.').glob('helper/*.[cm]')):
        expected.add('native-security')
    if not checks_pass(checks, expected):
        raise RuntimeError('Missing, pending, failed, or skipped checks block merge')
    for command in [['python3', '.security/metadata.py', 'history'], ['gitleaks', 'git', '--log-opts=--all', '--config', '.gitleaks.toml', '--redact=100', '--no-banner', '.'], ['python3', '.security/scan.py', 'all']]:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('Local full gates block merge')
    # GitHub rejects a changed PR head using this atomic SHA condition.
    result = subprocess.run(['gh', 'pr', 'merge', number, '--merge', '--delete-branch', '--match-head-commit', sha], capture_output=True)
    if result.returncode:
        raise RuntimeError('Merge failed or PR changed; re-review')
    print('Merged verified PR head after local gates and GitHub Actions PASS')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError):
        print('Merge BLOCKED: incomplete checks, changed head, or failed gate. No raw GitHub/source output printed.', file=sys.stderr)
        sys.exit(1)
