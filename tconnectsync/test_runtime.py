#!/usr/bin/env python3
"""Offline compatibility/security checks; never logs in or uploads pump data."""
import importlib.util
import json
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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
