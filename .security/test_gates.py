#!/usr/bin/env python3
"""Negative enforcement probes, including partially staged changes and outages."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gate', HERE / 'scan.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Gates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / '.security').mkdir()
        for name in ['scan.py', 'semgrep.yml']:
            shutil.copyfile(HERE / name, self.root / '.security' / name)
        (self.root / '.security/policy.json').write_text('{"audit":[],"semgrep":[]}')
        (self.root / '.semgrepignore').write_text('node_modules/\ndist/\n')
        (self.root / 'package.json').write_text('{"name":"security-probe","version":"0.0.0"}')
        (self.root / 'package-lock.json').write_text('{"name":"security-probe","lockfileVersion":3,"packages":{}}')
        self.oldroot = gate.ROOT
        gate.ROOT = self.root
        self.cmd(['git', 'init', '-q'])
        self.cmd(['git', 'add', '.'])
        # No test commits: probes never bypass a real repository's hook.

    def tearDown(self):
        gate.ROOT = self.oldroot
        self.temp.cleanup()

    def cmd(self, args):
        r = subprocess.run(args, cwd=self.root, capture_output=True)
        self.assertEqual(r.returncode, 0, 'Probe setup command failed')

    def test_staged_unsafe_worktree_safe_blocks(self):
        p = self.root / 'probe.js'
        p.write_text('eval(userInput);\n')
        self.cmd(['git', 'add', 'probe.js'])
        p.write_text('JSON.parse(userInput);\n')
        # Metadata initially staged would trigger real npm; check only source.
        self.cmd(['git', 'reset', '-q', '--', 'package.json', 'package-lock.json', '.security/policy.json'])
        self.cmd(['git', 'add', '.security/policy.json', 'package.json', 'package-lock.json'])
        # Fake npm returns a successful empty audit; source still comes from index.
        self.fake_npm({'vulnerabilities': {}}, 0)
        with self.assertRaises(RuntimeError):
            gate.staged()

    def test_staged_safe_worktree_unsafe_passes(self):
        p = self.root / 'probe.js'
        p.write_text('JSON.parse(userInput);\n')
        self.cmd(['git', 'add', 'probe.js'])
        p.write_text('eval(userInput);\n')
        self.fake_npm({'vulnerabilities': {}}, 0)
        gate.staged()

    def fake_npm(self, value, status):
        d = self.root / 'fake-bin'
        d.mkdir(exist_ok=True)
        p = d / 'npm'
        # The fixture contains only controlled JSON, no command substitution.
        p.write_text('#!/bin/sh\ncat <<\'JSON\'\n' + json.dumps(value) + '\nJSON\nexit ' + str(status) + '\n')
        p.chmod(0o755)
        old = os.environ['PATH']
        os.environ['PATH'] = str(d) + os.pathsep + old
        self.addCleanup(os.environ.__setitem__, 'PATH', old)

    def test_new_high_audit_blocks(self):
        self.fake_npm({'vulnerabilities': {'probe-dep': {'severity':'high','nodes':[],'via':[]}}}, 1)
        with self.assertRaises(RuntimeError):
            gate.audit(self.root, {'audit': []})

    def test_registry_failure_blocks(self):
        self.fake_npm({'error': {'code': 'ENETUNREACH'}}, 1)
        with self.assertRaises(RuntimeError):
            gate.audit(self.root, {'audit': []})

    def test_changed_dependency_not_covered(self):
        finding = {'severity':'high','nodes':['node_modules/probe-dep'],'via':[]}
        lock = {'packages': {'node_modules/probe-dep': {'version':'1.0.0'}}}
        key = gate.audit_key('probe-dep', finding, lock)
        (self.root / 'package-lock.json').write_text(json.dumps({'packages':{'node_modules/probe-dep':{'version':'1.0.1'}}}))
        self.fake_npm({'vulnerabilities':{'probe-dep':finding}}, 1)
        accepted = {'audit':[{'package':'probe-dep','sha256':key,'expires':'2099-01-01','reason':'probe','tracking':'probe'}]}
        with self.assertRaises(RuntimeError):
            gate.audit(self.root, accepted)

    def test_expired_policy_blocks(self):
        with self.assertRaises(RuntimeError):
            gate.exceptions({'audit':[{'expires':'2000-01-01','reason':'probe','tracking':'probe'}]}, 'audit')

    def test_parser_workaround_keeps_unsafe_code_visible(self):
        p = self.root / 'src/core/sonos.ts'
        p.parent.mkdir(parents=True)
        p.write_text(r'const s = body.replace(/<!--\s*SDT:[^>]*-->/g, "");' + '\neval(userInput);\n')
        gate.normalize_parser(self.root)
        with self.assertRaises(RuntimeError):
            gate.semgrep(self.root, {'semgrep': []}, ['src/core/sonos.ts'])

    def test_rules_reject_security_sinks(self):
        js = self.root / 'probe.js'
        js.write_text('import {exec} from "child_process";\nconst req = getRequest();\nexec(req.body);\nnew Function(userInput);\nspawn("tool", [], {shell:true});\nconst options = {rejectUnauthorized:false};\nprocess.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\ncrypto.createHash("md5");\n')
        py = self.root / 'probe.py'
        py.write_text('import subprocess, requests, pickle, yaml, hashlib\neval(userInput)\nsubprocess.run(cmd, shell=True)\nrequests.get(url, verify=False)\npickle.loads(data)\nyaml.load(data)\nhashlib.md5(data)\n')
        r = subprocess.run(['semgrep','scan','--config','.security/semgrep.yml','--error','--strict','--metrics','off','--disable-version-check','--json','probe.js','probe.py'],cwd=self.root,capture_output=True,text=True)
        self.assertEqual(r.returncode, 1)
        data = json.loads(r.stdout)
        self.assertFalse(data.get('errors'))
        found = {x['check_id'].split('.')[-1] for x in data['results']}
        expected = {'javascript-dynamic-eval','javascript-shell-mode','javascript-disabled-tls','javascript-tls-env-bypass','javascript-weak-password-hash','javascript-command-injection','python-dynamic-eval','python-shell-mode','python-disabled-tls','python-unsafe-deserialization','python-unsafe-yaml','python-weak-password-hash'}
        self.assertEqual(found, expected)

    def test_invalid_rule_blocks(self):
        (self.root / '.security/semgrep.yml').write_text('invalid: true')
        (self.root / 'probe.js').write_text('const safe = 1;')
        with self.assertRaises(RuntimeError):
            gate.semgrep(self.root, {'semgrep': []}, ['probe.js'])


if __name__ == '__main__':
    unittest.main()
