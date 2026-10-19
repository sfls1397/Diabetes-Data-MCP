#!/usr/bin/env python3
"""Merge only the reviewed PR head after a recorded local-gate PASS on that exact SHA."""
import json
import re
import subprocess
import sys

CONTEXT = 'local-gate'


def gh(args):
    result = subprocess.run(['gh'] + args, capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub request failed')
    return json.loads(result.stdout)


def gate_passed(statuses, login):
    # Only the owner's newest local-gate status on this SHA counts; GitHub Actions are not the gate.
    trusted = [s for s in statuses if s.get('context') == CONTEXT and s.get('creator', {}).get('login') == login]
    if not trusted:
        return False
    return max(trusted, key=lambda s: s['id']).get('state') == 'success'


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
    login = gh(['api', 'user'])['login']
    raw = gh(['api', '--paginate', '--slurp', 'repos/' + repo + '/commits/' + sha + '/statuses?per_page=100'])
    statuses = [s for page in raw for s in page]
    if not gate_passed(statuses, login):
        raise RuntimeError('No recorded local-gate PASS on this exact head; run .security/local-gate.py first')
    for command in [['python3', '.security/metadata.py', 'history'], ['gitleaks', 'git', '--log-opts=--all', '--config', '.gitleaks.toml', '--redact=100', '--no-banner', '.'], ['python3', '.security/scan.py', 'all']]:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('Local full gates block merge')
    # GitHub rejects a changed PR head using this atomic SHA condition.
    result = subprocess.run(['gh', 'pr', 'merge', number, '--merge', '--delete-branch', '--match-head-commit', sha], capture_output=True)
    if result.returncode:
        raise RuntimeError('Merge failed or PR changed; re-review')
    print('Merged verified PR head after recorded local-gate PASS and local full gates')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError):
        print('Merge BLOCKED: no recorded local-gate PASS, changed head, or failed gate. No raw GitHub/source output printed.', file=sys.stderr)
        sys.exit(1)
