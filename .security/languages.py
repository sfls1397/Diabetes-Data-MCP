#!/usr/bin/env python3
"""Additional local code checks for shell and macOS native helpers."""
import json
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def shell_file(path):
    data = path.read_bytes()[:256]
    return path.suffix == '.sh' or bool(re.match(rb'#![^\n]*\b(?:ba|da|k|z)?sh\b', data))


def check(root, targets=None, native_required=False):
    files = [root / name for name in targets] if targets is not None else [p for p in root.rglob('*') if p.is_file() and not p.is_symlink() and not any(part in {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv'} for part in p.relative_to(root).parts)]
    files = [p for p in files if p.is_file() and not p.is_symlink()]
    shells = [str(p.relative_to(root)) for p in files if shell_file(p)]
    native = [p for p in files if p.suffix in {'.c', '.m', '.mm'}]
    if shells:
        if not shutil.which('shellcheck'):
            raise RuntimeError('ShellCheck missing; run the repository installer')
        result = subprocess.run(['shellcheck', '--format=json', '--severity=warning', '--'] + shells, cwd=root, capture_output=True)
        issues = json.loads(result.stdout)
        if result.returncode not in (0, 1) or not isinstance(issues, list):
            raise RuntimeError('ShellCheck incomplete')
        for finding in issues:
            print('ShellCheck BLOCKED: %s:%s SC%s' % (finding['file'], finding['line'], finding['code']))
        if issues or result.returncode:
            raise RuntimeError('Shell code findings require repair')
        print('ShellCheck PASS (%s files; warning/error threshold)' % len(shells))
    if native and platform.system() != 'Darwin':
        if native_required:
            raise RuntimeError('Native helper analysis requires macOS')
        print('Native helpers: macOS analysis runs in the dedicated required native-security CI job')
    elif native:
        if not shutil.which('clang'):
            raise RuntimeError('Clang missing')
        sdk_dir = Path('/Library/Developer/CommandLineTools/SDKs')
        # Select an SDK compatible with the installed compiler, then fail on findings.
        sdks = [None] + sorted(sdk_dir.glob('MacOSX[0-9]*.sdk'), reverse=True) if sdk_dir.exists() else [None]
        for source in native:
            completed = False
            with tempfile.TemporaryDirectory(prefix='native-security-') as temp:
                output = Path(temp) / 'analysis.plist'
                for sdk in sdks:
                    output.unlink(missing_ok=True)
                    args = ['clang', '--analyze', '-Xanalyzer', '-analyzer-output=plist', '-o', str(output)]
                    if source.suffix in {'.m', '.mm'}:
                        args += ['-fobjc-arc']
                    if sdk:
                        args += ['-isysroot', str(sdk)]
                    result = subprocess.run(args + [str(source)], cwd=root, capture_output=True)
                    if result.returncode:
                        continue
                    if not output.exists():
                        raise RuntimeError('Native analyzer did not produce a report')
                    data = plistlib.loads(output.read_bytes())
                    if 'diagnostics' not in data:
                        raise RuntimeError('Malformed native report')
                    for finding in data['diagnostics']:
                        print('Clang BLOCKED: %s:%s %s' % (source.relative_to(root), finding.get('location', {}).get('line', '?'), finding.get('type', 'finding')))
                    if data['diagnostics']:
                        raise RuntimeError('Native code findings require repair')
                    completed = True
                    break
            if not completed:
                raise RuntimeError('Native helper analysis could not complete')
        print('Clang native analysis PASS (%s helpers)' % len(native))


if __name__ == '__main__':
    try:
        check(Path.cwd(), native_required=True)
    except (OSError, ValueError, RuntimeError, KeyError):
        print('Additional language gate BLOCKED; source/error values omitted.', file=sys.stderr)
        sys.exit(1)
