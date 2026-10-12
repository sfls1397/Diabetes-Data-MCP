#!/usr/bin/env python3
"""Check Git privacy metadata without printing identity or message values."""
import re
import subprocess
import sys
from pathlib import Path

# Public tool attribution in pre-existing history is not a personal identity.
# New commits must always use GitHub noreply, including tool-generated commits.
PUBLIC_TOOL_IDENTITIES = {'cursoragent@cursor.com', 'noreply@anthropic.com'}
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PRIVATE_PATH = re.compile(r'/Users/(?!example(?:/|$|[^A-Za-z0-9._-])|test(?:/|$|[^A-Za-z0-9._-])|fixture(?:/|$|[^A-Za-z0-9._-])|REPLACE_ME(?:/|$|[^A-Za-z0-9._-]))[A-Za-z0-9._-]+')
PRIVATE_HOST = re.compile(r'\b[A-Za-z0-9-]+\.(?:lan|local)\b', re.I)


def run(args):
    result = subprocess.run(['git'] + args, capture_output=True)
    if result.returncode:
        raise RuntimeError('Git metadata could not be read')
    return result.stdout


def github_email(email):
    return email == 'noreply@github.com' or bool(re.fullmatch(r'[A-Za-z0-9+._-]+@users\.noreply\.github\.com', email))


def message_ok(message):
    if PRIVATE_PATH.search(message) or PRIVATE_HOST.search(message):
        return False
    for match in EMAIL.finditer(message):
        email = match.group(0)
        domain = email.rsplit('@', 1)[-1].lower()
        if github_email(email) or email in PUBLIC_TOOL_IDENTITIES or domain in {'example.com', 'example.net', 'example.org'} or domain.endswith('.invalid'):
            continue
        return False
    return True


def prospective():
    for role in ['AUTHOR', 'COMMITTER']:
        ident = run(['var', 'GIT_' + role + '_IDENT']).decode('utf-8', 'strict')
        match = re.search(r'<([^<>]+)>', ident)
        if not match or not github_email(match.group(1)):
            raise RuntimeError('Commit blocked: author and committer must use GitHub noreply')
    print('Git prospective identity PASS')


def history():
    commits = run(['rev-list', '--all']).decode('ascii').splitlines()
    blocked = []
    # cat-file reads the real commit headers; mailmap cannot hide an identity.
    process = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for oid in commits:
            process.stdin.write((oid + '\n').encode('ascii'))
            process.stdin.flush()
            header = process.stdout.readline().decode('ascii').split()
            if len(header) != 3 or header[1] != 'commit':
                raise RuntimeError('Incomplete Git commit object')
            data = process.stdout.read(int(header[2]))
            if len(data) != int(header[2]) or process.stdout.read(1) != b'\n':
                raise RuntimeError('Incomplete Git commit object')
            headers, message = data.split(b'\n\n', 1)
            fields = [line for line in headers.splitlines() if line.startswith((b'author ', b'committer '))]
            good = len(fields) == 2
            for field in fields:
                match = re.search(rb'<([^<>]+)>', field)
                email = match.group(1).decode('utf-8', 'strict') if match else ''
                good = good and (github_email(email) or email in PUBLIC_TOOL_IDENTITIES)
            good = good and message_ok(message.decode('utf-8', 'strict'))
            if not good:
                blocked.append(oid)
    finally:
        process.stdin.close()
        process.wait()
        process.stdout.close()
    if process.returncode:
        raise RuntimeError('Git object scan did not complete')
    if blocked:
        for oid in blocked[:20]:
            print('Git metadata BLOCKED: ' + oid[:12] + ' (private identity/message; values omitted)')
        raise RuntimeError(str(len(blocked)) + ' commit(s) have noncompliant privacy metadata')
    print('Git history metadata PASS (' + str(len(commits)) + ' commits)')


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'history'
    if mode == 'prospective':
        prospective()
    elif mode == 'history':
        history()
    elif mode == 'message' and len(sys.argv) == 3:
        if not message_ok(Path(sys.argv[2]).read_text()):
            raise RuntimeError('Commit message contains private metadata; values omitted')
        print('Git commit-message privacy PASS')
    else:
        raise RuntimeError('Use prospective, history, or message FILE')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, UnicodeError):
        print('Git metadata gate BLOCKED: private identity/message or incomplete scan. Use GitHub noreply and neutral text.', file=sys.stderr)
        sys.exit(1)
