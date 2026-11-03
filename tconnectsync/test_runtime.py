#!/usr/bin/env python3
"""Offline compatibility/security checks; never logs in or uploads pump data."""
import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr
from io import StringIO

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from tconnectsync.api.tandemsource import TandemSourceApi
import diabetes_tconnectsync

spec = importlib.util.spec_from_file_location('dependency_audit', Path(__file__).with_name('audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class FixtureApi(TandemSourceApi):
    TDC_OIDC_JWKS_URL = 'https://fixture.invalid/keys'
    TDC_OIDC_CLIENT_ID = 'fixture-client'
    TDC_OIDC_ISSUER = 'fixture-issuer'


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def api(self, *, issuer='fixture-issuer', key=None, expiration=4102444800):
        instance = FixtureApi.__new__(FixtureApi)
        claims = {'iss': issuer, 'aud': 'fixture-client', 'exp': expiration,
                  'pumperId': 'fixture-pumper', 'accountId': 'fixture-account'}
        instance.idToken = jwt.encode(claims, key or self.key, algorithm='RS256', headers={'kid': 'fixture-key'})
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
        jwk['kid'] = 'fixture-key'
        instance.loginSession = SimpleNamespace(get=lambda _: SimpleNamespace(json=lambda: {'keys': [jwk]}))
        return instance

    def test_real_tandem_token_verification_with_updated_pyjwt(self):
        instance = self.api()
        instance.extract_jwt()
        self.assertEqual(instance.pumperId, 'fixture-pumper')
        self.assertEqual(instance.accountId, 'fixture-account')

    def test_wrong_signature_still_rejected(self):
        with self.assertRaises(jwt.InvalidSignatureError):
            self.api(key=self.wrong_key).extract_jwt()

    def test_wrong_issuer_still_rejected(self):
        with self.assertRaises(jwt.InvalidIssuerError):
            self.api(issuer='untrusted-fixture').extract_jwt()

    def test_expired_token_still_rejected(self):
        with self.assertRaises(jwt.ExpiredSignatureError):
            self.api(expiration=1).extract_jwt()

    def test_combo_hook_preserved(self):
        self.assertTrue(diabetes_tconnectsync.install())
        self.assertTrue(diabetes_tconnectsync.install())

    def test_authentication_log_values_and_tracebacks_never_escape(self):
        filt = diabetes_tconnectsync.AuthLogFilter()
        info = logging.LogRecord('fixture', logging.INFO, '', 1, 'fixture-private-token', (), None)
        self.assertFalse(filt.filter(info))
        record = logging.LogRecord('fixture', logging.ERROR, '', 1, '%s', ('fixture-private-token',),
                                   (ValueError, ValueError('fixture-private-token'), None))
        self.assertTrue(filt.filter(record))
        self.assertEqual(record.getMessage(), 'Tandem authentication: error')
        self.assertIsNone(record.exc_info)
        self.assertIsNone(record.exc_text)

    def test_private_exception_is_nonzero_and_masked(self):
        output = StringIO()
        with patch('sys.argv', ['fixture']), patch('tconnectsync.main', side_effect=ValueError('fixture-private-token')):
            with redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 1)
        self.assertNotIn('fixture-private-token', output.getvalue())

    def test_diagnostic_hooks_cover_each_tandem_stage_and_preserve_calls(self):
        from tconnectsync.nightscout import NightscoutApi
        from tconnectsync.sync.tandemsource.process import ProcessTimeRange
        from tconnectsync.api.common import ApiException
        import requests

        cases = [(TandemSourceApi, 'login', 'Tandem auth', ApiException(401, 'fixture-private-token'), 'auth'),
                 (TandemSourceApi, '_get', 'Tandem fetch', requests.exceptions.Timeout('fixture-private-token'), 'timeout'),
                 (NightscoutApi, 'current_profile', 'Nightscout fetch', ApiException(503, 'fixture-private-token'), 'http_5xx'),
                 (NightscoutApi, 'upload_entry', 'Nightscout upload', ApiException(422, 'fixture-private-token'), 'http_4xx'),
                 (ProcessTimeRange, 'process', 'Tandem parse', ValueError('fixture-private-token'), 'parse')]
        for owner, method, stage, error, category in cases:
            with self.subTest(stage=stage):
                calls = []

                def fail(*args, **kwargs):
                    calls.append((args, kwargs))
                    raise error

                with patch.object(owner, method, fail):
                    diabetes_tconnectsync.install_diagnostics()
                    diabetes_tconnectsync.install_diagnostics()
                    output = StringIO()
                    with patch('sys.argv', ['fixture']), patch('tconnectsync.main',
                            side_effect=lambda: getattr(owner, method)('fixture-private-token', payload='fixture-private-token')):
                        with redirect_stderr(output):
                            self.assertEqual(diabetes_tconnectsync.main(), 1)
                    record = json.loads(output.getvalue())
                    self.assertEqual(set(record), {'timestamp', 'stage', 'category'})
                    self.assertEqual(record['stage'], stage)
                    self.assertEqual(record['category'], category)
                    self.assertNotIn('fixture-private-token', output.getvalue())
                    self.assertEqual(calls, [(('fixture-private-token',), {'payload': 'fixture-private-token'})])

    def test_system_exit_codes_and_success_preserved(self):
        for code in [0, 1, 2]:
            output = StringIO()
            with patch('sys.argv', ['fixture']), patch('tconnectsync.main', side_effect=SystemExit(code)):
                with redirect_stderr(output), self.assertRaises(SystemExit) as result:
                    diabetes_tconnectsync.main()
            self.assertEqual(result.exception.code, code)
            if code:
                self.assertEqual(json.loads(output.getvalue())['stage'], 'sync completion')
            else:
                self.assertEqual(output.getvalue(), '')

    def test_real_nightscout_upload_boundary_classifies_response_without_body(self):
        from tconnectsync.nightscout import NightscoutApi
        diabetes_tconnectsync.install_diagnostics()
        instance = NightscoutApi('https://fixture.invalid', 'fixture-private-token')
        output = StringIO()
        response = SimpleNamespace(status_code=503, text='fixture-private-token')
        with patch('tconnectsync.nightscout.requests.post', return_value=response), \
                patch('sys.argv', ['fixture']), patch('tconnectsync.main', side_effect=lambda: instance.upload_entry({'fixture': 'fixture-private-token'})):
            with redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 1)
        record = json.loads(output.getvalue())
        self.assertEqual(record['stage'], 'Nightscout upload')
        self.assertEqual(record['category'], 'http_5xx')
        self.assertNotIn('fixture-private-token', output.getvalue())

    def test_startup_exception_and_unsupported_version_fallback(self):
        output = StringIO()
        with patch('sys.argv', ['fixture']), patch.object(diabetes_tconnectsync, 'install', side_effect=RuntimeError('fixture-private-token')):
            with redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['stage'], 'startup')
        self.assertNotIn('fixture-private-token', output.getvalue())
        with patch('sys.argv', ['fixture']), patch.object(diabetes_tconnectsync, 'install', return_value=False), \
                patch.object(diabetes_tconnectsync, 'install_diagnostics') as hook, patch('tconnectsync.main', return_value=0):
            self.assertEqual(diabetes_tconnectsync.main(), 0)
            hook.assert_not_called()

    def test_real_import_validation_never_prints_configuration(self):
        for key in ['TCONNECT_REGION', 'PUMP_SERIAL_NUMBER']:
            env = {**os.environ, 'TCONNECT_EMAIL': 'fixture', 'TCONNECT_PASSWORD': 'fixture',
                   'NS_SECRET': 'fixture', 'TCONNECT_REGION': 'US', 'PUMP_SERIAL_NUMBER': '11111111',
                   key: 'fixture-private-token'}
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('diabetes_tconnectsync.py')),
                                     '--combo-selftest'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('fixture-private-token', result.stderr)
            record = json.loads(result.stderr)
            self.assertEqual(set(record), {'timestamp', 'category', 'stage'})
            self.assertEqual(record['stage'], 'startup')

    def test_zero_event_diagnostic_preserves_watchdog_terminal_line_contract(self):
        output = StringIO()
        logger = logging.getLogger('tconnectsync.sync.tandemsource.process')
        old_level, old_propagate = logger.level, logger.propagate
        handler = logging.StreamHandler(output)
        handler.setFormatter(logging.Formatter('2026-11-03 14:35:12 INFO %(message)s'))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False

        def finish():
            logger.info('Processed 0 events. Last event ID seen: -1')
            raise SystemExit(1)

        try:
            logging.disable(logging.NOTSET)
            with patch('sys.argv', ['fixture']), patch('tconnectsync.main', side_effect=finish):
                with redirect_stderr(output), self.assertRaises(SystemExit) as result:
                    diabetes_tconnectsync.main()
            self.assertEqual(result.exception.code, 1)
        finally:
            logging.disable(logging.CRITICAL)
            logger.removeHandler(handler)
            logger.setLevel(old_level)
            logger.propagate = old_propagate
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])['stage'], 'sync completion')
        self.assertEqual(lines[-1], '2026-11-03 14:35:12 INFO Processed 0 events. Last event ID seen: -1')

    def test_advisory_outage_blocks(self):
        with patch.object(audit.urllib.request, 'urlopen', side_effect=OSError('fixture outage')):
            with self.assertRaises(OSError):
                audit.findings({'pyjwt': '2.8.0'})

    def test_advisory_and_incomplete_response_not_silently_accepted(self):
        for data in [{'results': []}, {'results': [{'error': 'fixture'}]},
                     {'results': [{'next_page_token': 'fixture'}]}]:
            from io import BytesIO
            with patch.object(audit.urllib.request, 'urlopen', return_value=BytesIO(json.dumps(data).encode())):
                with self.assertRaises(RuntimeError):
                    audit.findings({'pyjwt': '2.8.0'})
        from io import BytesIO
        with patch.object(audit.urllib.request, 'urlopen', return_value=BytesIO(
                b'{"results":[{"vulns":[{"id":"GHSA-fixture"}]}]}')):
            self.assertEqual(audit.findings({'pyjwt': '2.8.0'}), [('pyjwt', 'GHSA-fixture')])


if __name__ == '__main__':
    unittest.main()
