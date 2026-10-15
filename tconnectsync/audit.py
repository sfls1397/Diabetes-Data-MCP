#!/usr/bin/env python3
"""Fail closed on known advisories in the locked or installed Python graph."""
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import urllib.request


def normalize(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def locked(root):
    result = {}
    for line in (root / 'requirements.lock').read_text().splitlines():
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s]+) \\', line)
        if match:
            name, version = match.groups()
            if normalize(name) in result:
                raise RuntimeError('Duplicate Python dependency')
            result[normalize(name)] = version
    if len(result) < 30:
        raise RuntimeError('Incomplete Python dependency lock')
    result['tconnectsync'] = '3.0.3'
    profile = json.loads((root / 'runtime-profile.json').read_text())
    if result.get('pyjwt') != profile['pyjwt']:
        raise RuntimeError('Python profile and lock disagree')
    return result


def findings(packages):
    names = sorted(packages)
    body = {'queries': [{'package': {'ecosystem': 'PyPI', 'name': name},
                         'version': packages[name]} for name in names]}
    request = urllib.request.Request('https://api.osv.dev/v1/querybatch',
                                     data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    results = data['results']
    if not isinstance(results, list) or len(results) != len(names):
        raise RuntimeError('Incomplete Python advisory response')
    blocked = []
    for name, result in zip(names, results):
        if not isinstance(result, dict) or 'error' in result or result.get('next_page_token'):
            raise RuntimeError('Invalid Python advisory response')
        for item in result.get('vulns', []):
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                raise RuntimeError('Invalid Python advisory finding')
            blocked.append((name, item['id']))
    return blocked


def main():
    expected = locked(Path(__file__).resolve().parent)
    if '--installed' in sys.argv:
        actual = {normalize(d.metadata['Name']): d.version
                  for d in importlib.metadata.distributions()}
        if actual != expected:
            raise RuntimeError('Installed Python graph differs from reviewed lock')
    blocked = findings(expected)
    for name, advisory in blocked:
        print('Python advisory BLOCKED: %s %s' % (name, advisory))
    if blocked:
        raise RuntimeError('Python dependency advisories block activation')
    print('Python dependency audit PASS (%d packages; zero known advisories)' % len(expected))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Python dependency audit failed; activation blocked', file=sys.stderr)
        sys.exit(1)
