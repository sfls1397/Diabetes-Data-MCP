#!/usr/bin/env python3
"""Security regression probes use only disposable repositories and synthetic data."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
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


def scratch_worktree_repo(temp):
    """A repo whose main commit is clean, plus another job's leftovers sharing its refs: a debug worktree on a detached
    commit and a local branch, both authored on example.invalid. Returns (root, clean main sha, debug sha)."""
    root = temp / 'repo'
    (root / '.githooks').mkdir(parents=True)
    (root / '.security').mkdir()
    (root / 'README').write_text('probe\n')
    clean = ['git', '-c', 'user.name=probe', '-c', 'user.email=probe@users.noreply.github.com', '-c', 'commit.gpgsign=false']
    for args in [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'probe']]:
        subprocess.run(clean + args, cwd=root, check=True, capture_output=True)
    debug = ['git', '-c', 'user.name=dbg', '-c', 'user.email=dbg@example.invalid', '-c', 'commit.gpgsign=false']
    scratch = temp / 'x-gate-affected' / 'dbg'
    subprocess.run(['git', 'worktree', 'add', '-q', '--detach', str(scratch)], cwd=root, check=True, capture_output=True)
    subprocess.run(debug + ['commit', '-q', '--allow-empty', '-m', 'debug'], cwd=scratch, check=True, capture_output=True)
    subprocess.run(['git', 'branch', 'scratch-debug', 'HEAD'], cwd=scratch, check=True, capture_output=True)
    head = lambda where: subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=where, check=True, capture_output=True, text=True).stdout.strip()
    return root, head(root), head(scratch)


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
            subprocess.run(['git', '-C', str(root), 'symbolic-ref', 'HEAD', 'refs/heads/main'], check=True)
            (root / '.mailmap').write_text('Fixture <fixture@users.noreply.github.com> <fixture@example.com>\n')
            previous = Path.cwd()
            try:
                os.chdir(root)
                with self.assertRaises(RuntimeError):
                    metadata.history()
            finally:
                os.chdir(previous)

    def test_history_ignores_another_jobs_scratch_worktree(self):
        # Toolbox PR 554 (Nov 12): a debug worktree's commit (author on example.invalid) failed a push and a gate,
        # because the scan read rev-list --all, which takes in every branch and every linked worktree's HEAD.
        with tempfile.TemporaryDirectory() as temp:
            root, pushed, foreign = scratch_worktree_repo(Path(temp))
            gate = Path(__file__).with_name('metadata.py')
            clean = subprocess.run([sys.executable, str(gate), 'history'], cwd=root, capture_output=True, text=True)
            self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
            self.assertIn('Git history metadata PASS', clean.stdout)
            tip = subprocess.run([sys.executable, str(gate), 'history', pushed], cwd=root, capture_output=True, text=True)
            self.assertEqual(tip.returncode, 0, tip.stdout + tip.stderr)
            # The same commit still blocks when it is the one being checked.
            bad = subprocess.run([sys.executable, str(gate), 'history', foreign], cwd=root, capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertIn('Git metadata BLOCKED: ' + foreign[:12], bad.stdout)
            # An option can never come in as a revision.
            option = subprocess.run([sys.executable, str(gate), 'history', '--all'], cwd=root, capture_output=True, text=True)
            self.assertEqual(option.returncode, 1)

    def test_pre_push_checks_only_the_pushed_commits(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            root, pushed, foreign = scratch_worktree_repo(temp)
            hooks = Path(__file__).resolve().parent.parent
            shutil.copy(hooks / '.githooks/pre-push', root / '.githooks/pre-push')
            shutil.copy(hooks / '.security/metadata.py', root / '.security/metadata.py')
            (root / '.security/scan.py').write_text('import sys\nopen("scan.log", "a").write("scan\\n")\n')
            home = temp / 'home'
            (home / '.local/bin').mkdir(parents=True)
            (home / '.local/bin/gitleaks').write_text('#!/bin/sh\nprintf "%%s\\n" "$*" >> %s/gitleaks.log\n' % temp)
            (home / '.local/bin/gitleaks').chmod(0o755)
            env = dict(os.environ, HOME=str(home))
            zero = '0' * 40

            def push(lines):
                return subprocess.run(['sh', '.githooks/pre-push', 'origin', 'https://example.invalid/repo.git'], cwd=root, env=env,
                                      input=''.join(lines), capture_output=True, text=True)

            ok = push(['refs/heads/main %s refs/heads/main %s\n' % (pushed, zero)])
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            calls = (temp / 'gitleaks.log').read_text().splitlines()
            self.assertEqual(len(calls), 1)
            self.assertIn('--log-opts=' + pushed + ' ', calls[0])
            self.assertNotIn('--all', calls[0])
            blocked = push(['refs/heads/main %s refs/heads/main %s\n' % (pushed, zero),
                            'refs/heads/dbg %s refs/heads/dbg %s\n' % (foreign, zero)])
            self.assertEqual(blocked.returncode, 1)
            self.assertIn('Git metadata BLOCKED: ' + foreign[:12], blocked.stdout)
            # A delete pushes no commits, so neither history scan runs; the file scan still does.
            deleted = push(['(delete) %s refs/heads/old %s\n' % (zero, pushed)])
            self.assertEqual(deleted.returncode, 0, deleted.stdout + deleted.stderr)
            self.assertEqual(len((temp / 'gitleaks.log').read_text().splitlines()), 1)
            self.assertEqual((root / 'scan.log').read_text().count('scan'), 2)

    def test_gate_and_merge_scan_only_the_checked_head(self):
        runner = module('local_gate_scope', 'local-gate.py')
        commands = dict(runner.STANDARD)
        self.assertEqual(commands['Git metadata (raw author/committer, messages)'][-2:], ['history', 'HEAD'])
        self.assertIn('--log-opts=HEAD', commands['Gitleaks full history'])
        merging = merge.full_gates()
        self.assertEqual(merging[0][-2:], ['history', 'HEAD'])
        self.assertIn('--log-opts=HEAD', merging[1])
        for args in list(commands.values()) + merging:
            self.assertFalse(any('--all' in arg for arg in args), args)

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
