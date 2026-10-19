#!/usr/bin/env python3
"""Security regression probes use only disposable repositories and synthetic data."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


metadata = module('privacy_metadata', 'metadata.py')
languages = module('language_checks', 'languages.py')
merge = module('verified_merge', 'merge-pr.py')


class Standard(unittest.TestCase):
    def test_email_policy(self):
        self.assertTrue(metadata.github_email('fixture@users.noreply.github.com'))
        self.assertTrue(metadata.github_email('noreply@github.com'))
        self.assertFalse(metadata.github_email('fixture@example.com'))
        self.assertFalse(metadata.github_email('fixture@users.noreply.github.com.invalid'))

    def test_message_privacy(self):
        self.assertTrue(metadata.message_ok('Fix parsing\n\nCo-authored-by: Tool <noreply@anthropic.com>'))
        self.assertFalse(metadata.message_ok('Contact: fixture@private.invalid-domain.org'))
        self.assertFalse(metadata.message_ok('Run on fixture' + '.' + 'lan'))
        self.assertFalse(metadata.message_ok('Saved to /Users/' + 'fixture-owner'))

    def test_history_reads_raw_author_even_with_mailmap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            tree = subprocess.run(['git', '-C', str(root), 'hash-object', '-w', '-t', 'tree', '--stdin'], input=b'', capture_output=True, check=True).stdout.strip()
            raw = b'tree ' + tree + b'\nauthor Fixture <fixture@example.com> 1 +0000\ncommitter Fixture <fixture@users.noreply.github.com> 1 +0000\n\nSynthetic probe\n'
            oid = subprocess.run(['git', '-C', str(root), 'hash-object', '-w', '-t', 'commit', '--stdin'], input=raw, capture_output=True, check=True).stdout.strip()
            subprocess.run(['git', '-C', str(root), 'update-ref', 'refs/heads/main', oid], check=True)
            (root / '.mailmap').write_text('Fixture <fixture@users.noreply.github.com> <fixture@example.com>\n')
            previous = Path.cwd()
            try:
                os.chdir(root)
                with self.assertRaises(RuntimeError):
                    metadata.history()
            finally:
                os.chdir(previous)

    def test_extensionless_shell_is_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'wrapper').write_text('#!/bin/sh\nPREFIX= cd /tmp\n')
            with self.assertRaises(RuntimeError):
                languages.check(root)

    @unittest.skipUnless(__import__('platform').system() == 'Darwin', 'macOS native job owns this probe')
    def test_native_bug_blocks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'probe.c').write_text('void f(void) { int *p = 0; *p = 1; }\n')
            with self.assertRaises(RuntimeError):
                languages.check(root, native_required=True)

    def test_merge_requires_recorded_local_gate(self):
        def status(state, ident=1, login='owner', context='local-gate'):
            return {'context': context, 'id': ident, 'state': state, 'creator': {'login': login}}
        self.assertTrue(merge.gate_passed([status('success')], 'owner'))
        self.assertFalse(merge.gate_passed([], 'owner'))
        self.assertFalse(merge.gate_passed([status('pending')], 'owner'))
        self.assertFalse(merge.gate_passed([status('failure')], 'owner'))
        self.assertFalse(merge.gate_passed([status('success', login='someone-else')], 'owner'))
        self.assertFalse(merge.gate_passed([status('success', context='gitleaks')], 'owner'))
        self.assertFalse(merge.gate_passed([status('success'), status('failure', ident=2)], 'owner'))
        self.assertTrue(merge.gate_passed([status('failure'), status('success', ident=2)], 'owner'))

    def test_local_gate_steps_fail_closed(self):
        runner = module('local_gate', 'local-gate.py')
        with tempfile.TemporaryDirectory() as temp:
            tree = Path(temp)
            (tree / '.security').mkdir()
            (tree / '.security/local-gate.json').write_text('{"tests": [["npm", "test"]]}')
            names = [step for step, _ in runner.steps(tree)]
            for required in ['Gitleaks full history', 'Tests: npm test',
                             'npm audit (production, high) + offline Semgrep + ShellCheck/Clang']:
                self.assertIn(required, names)
            (tree / '.security/local-gate.json').write_text('{"tests": ["npm test"]}')
            with self.assertRaises(runner.GateError):
                runner.steps(tree)


if __name__ == '__main__':
    unittest.main()
