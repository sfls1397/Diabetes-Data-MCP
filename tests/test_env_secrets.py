import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import sync_from_nightscout as sync

ENV_URL = "http://env-fixture.invalid:1"
ENV_SECRET = "env-fixture-secret"
KC_URL = "http://keychain-fixture.invalid:2"
KC_SECRET = "keychain-fixture-secret"


class EnvFirstTests(unittest.TestCase):
    def load(self, env, keychain):
        calls = []

        def fake_keychain(service, account):
            calls.append(account)
            return keychain.get(account)

        clean = {k: v for k, v in os.environ.items() if k not in ("NIGHTSCOUT_URL", "NIGHTSCOUT_API_SECRET")}
        with patch.dict(os.environ, {**clean, **env}, clear=True), patch.object(sync, "keychain_get", fake_keychain):
            return sync.load_nightscout_auth.__wrapped__(), calls

    def test_both_variables_win_and_the_keychain_is_not_read(self):
        result, calls = self.load({"NIGHTSCOUT_URL": ENV_URL, "NIGHTSCOUT_API_SECRET": ENV_SECRET}, {})
        self.assertEqual(result, (ENV_URL, ENV_SECRET))
        self.assertEqual(calls, [])

    def test_secret_alone_from_the_environment_with_an_empty_keychain_secret(self):
        result, calls = self.load({"NIGHTSCOUT_API_SECRET": ENV_SECRET}, {"nightscout-url": KC_URL})
        self.assertEqual(result, (KC_URL, ENV_SECRET))
        self.assertEqual(calls, ["nightscout-url"])

    def test_url_alone_from_the_environment(self):
        result, calls = self.load({"NIGHTSCOUT_URL": ENV_URL}, {"api-secret": KC_SECRET})
        self.assertEqual(result, (ENV_URL, KC_SECRET))
        self.assertEqual(calls, ["api-secret"])

    def test_unset_or_empty_variables_read_the_keychain_as_today(self):
        for env in ({}, {"NIGHTSCOUT_URL": "", "NIGHTSCOUT_API_SECRET": "  "}):
            result, calls = self.load(env, {"nightscout-url": KC_URL + "/", "api-secret": KC_SECRET})
            self.assertEqual(result, (KC_URL, KC_SECRET))
            self.assertEqual(sorted(calls), ["api-secret", "nightscout-url"])

    def test_missing_everywhere_fails_closed_without_values(self):
        with self.assertRaises(sync.MissingCredentials) as caught:
            self.load({"NIGHTSCOUT_URL": ENV_URL}, {})
        self.assertNotIn(ENV_URL, str(caught.exception))
        self.assertIn("api-secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
