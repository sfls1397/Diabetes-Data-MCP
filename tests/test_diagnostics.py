import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import failure_diagnostics as diagnostics
import sync_from_nightscout as sync

CANARY = "fixture-private-response-with-credentials-and-health-payload"


class DiagnosticsTests(unittest.TestCase):
    def record(self, output, stage, category):
        self.assertNotIn(CANARY, output)
        record = json.loads(output)
        self.assertEqual(set(record), {"timestamp", "stage", "category"})
        self.assertRegex(record["timestamp"], r"^\d{4}-\d\d-\d\dT.*Z$")
        self.assertEqual(record["stage"], stage)
        self.assertEqual(record["category"], category)

    def test_fixed_categories_and_no_exception_serialization(self):
        class Unprintable(Exception):
            def __str__(self):
                raise AssertionError("must never serialize")

        cases = [(TimeoutError(CANARY), "timeout"),
                 (urllib.error.URLError(TimeoutError(CANARY)), "timeout"),
                 (socket.timeout(CANARY), "timeout"),
                 (urllib.error.URLError(socket.timeout(CANARY)), "timeout"),
                 (urllib.error.URLError(CANARY), "transport"),
                 (sqlite3.OperationalError(CANARY), "db"),
                 (ValueError(CANARY), "parse"), (Unprintable(), "unknown")]
        for status, category in [(401, "auth"), (403, "auth"), (404, "http_4xx"),
                                 (503, "http_5xx"), (302, "http_other")]:
            cases.append((urllib.error.HTTPError(CANARY, status, CANARY, {}, None), category))
        for error, category in cases:
            self.record(diagnostics.diagnostic(error, stage="Nightscout fetch"), "Nightscout fetch", category)
        self.record(diagnostics.diagnostic(stage=CANARY, kind=CANARY), "unknown", "unknown")

    def test_sqlite_stage_failures_exit_nonzero_without_payload(self):
        cases = [("ensure_auth", sync.MissingCredentials(CANARY), "credential lookup", "auth", 2),
                 ("connect", sqlite3.OperationalError(CANARY), "SQLite open", "db", 1),
                 ("ns_get", TimeoutError(CANARY), "Nightscout fetch", "timeout", 1),
                 ("ns_get", socket.timeout(CANARY), "Nightscout fetch", "timeout", 1),
                 ("upsert_sgv", sqlite3.OperationalError(CANARY), "SQLite write", "db", 1),
                 ("commit", sqlite3.OperationalError(CANARY), "SQLite commit", "db", 1),
                 ("recompute_range", ValueError(CANARY), "SQLite stats", "parse", 1)]
        for function, error, stage, kind, code in cases:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                def fail(*args, **kwargs):
                    raise error

                replacements = {"BASE": "https://fixture.invalid", "API_SECRET": CANARY,
                                "DB_PATH": Path(directory) / "archive.sqlite",
                                "LOCK_PATH": Path(directory) / "lock"}
                if function != "ns_get":
                    replacements["ns_get"] = lambda _: [{"date": 0, "sgv": 100}] if function == "upsert_sgv" else []
                output = io.StringIO()
                with patch.multiple(sync, **replacements), patch.object(sys, "argv", ["fixture", "sync"]):
                    with patch.object(sync, function, diagnostics.staged(stage)(fail)):
                        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(output):
                            self.assertEqual(sync.main(), code)
                self.record(output.getvalue(), stage, kind)

    def test_real_fetch_and_parse_boundaries(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = CANARY.encode()
        with patch.object(sync, "ensure_auth", return_value=("https://fixture.invalid", CANARY)), \
             patch.object(sync, "api_secret_header", return_value=CANARY), \
             patch.object(sync.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(ValueError) as result:
                sync.ns_get("/fixture")
        self.record(diagnostics.diagnostic(result.exception), "Nightscout parse", "parse")

    def test_real_commit_boundary(self):
        connection = sqlite3.connect(":memory:")
        connection.close()
        with self.assertRaises(sqlite3.Error) as result:
            sync.commit(connection)
        self.record(diagnostics.diagnostic(result.exception), "SQLite commit", "db")

    def test_profile_error_metadata_is_only_the_diagnostic_and_behavior_unchanged(self):
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        sync.init_db(connection)
        output = io.StringIO()
        error = urllib.error.HTTPError(CANARY, 503, CANARY, {}, None)
        with patch.object(sync, "ns_get", diagnostics.staged("Nightscout fetch")(lambda _: (_ for _ in ()).throw(error))):
            with contextlib.redirect_stderr(output):
                self.assertFalse(sync.sync_profiles_safely(connection, full=True))
        self.record(output.getvalue(), "Nightscout fetch", "http_5xx")
        saved = connection.execute("SELECT value FROM meta WHERE key='profile_last_error'").fetchone()[0]
        self.assertEqual(saved, output.getvalue().strip())
        connection.close()

    def test_wrapper_credential_failure_preserves_exit_two(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "venv/bin").mkdir(parents=True)
            binary = home / "venv/bin/tconnectsync"
            binary.write_text("#!/bin/sh\nexit 99\n")
            binary.chmod(0o700)
            security = home / "security"
            security.write_text("#!/bin/sh\nprintf '%s' '" + CANARY + "' >&2\nexit 1\n")
            security.chmod(0o700)
            result = subprocess.run(["sh", str(Path(__file__).resolve().parents[1] / "tconnectsync/diabetes-tconnectsync")],
                                    env={**os.environ, "DIABETES_TCONNECTSYNC_HOME": directory,
                                         "PATH": directory + ":/usr/bin:/bin"}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.record(result.stderr, "credential lookup", "auth")

    def test_startup_configuration_and_missing_runtime_fail_privately(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, str(root / "sync/sync_from_nightscout.py")],
                                env={**os.environ, "DIABETES_SYNC_PAGE": CANARY}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.record(result.stderr, "startup", "parse")
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(["sh", str(root / "tconnectsync/diabetes-tconnectsync")],
                                    env={**os.environ, "DIABETES_TCONNECTSYNC_HOME": directory},
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.record(result.stderr, "startup", "unknown")

    def test_missing_interpreter_matches_shell_exec_status_without_raw_path(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "venv/bin").mkdir(parents=True)
            binary = home / "venv/bin/tconnectsync"
            binary.write_text("#!/bin/sh\nexit 99\n")
            binary.chmod(0o700)
            security = home / "security"
            security.write_text("#!/bin/sh\nprintf fixture\n")
            security.chmod(0o700)
            env = {**os.environ, "DIABETES_TCONNECTSYNC_HOME": directory, "PATH": directory + ":/usr/bin:/bin"}
            baseline = home / "baseline.sh"
            baseline.write_text('#!/bin/sh\nset -eu\nexec "$1"\n')
            expected = subprocess.run(["sh", str(baseline), str(home / "venv/bin/python")],
                                      capture_output=True, text=True).returncode
            result = subprocess.run(["sh", str(root / "tconnectsync/diabetes-tconnectsync")],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, expected)
            self.assertEqual(result.stdout, "")
            self.assertNotIn(directory, result.stderr)
            self.record(result.stderr, "startup", "unknown")

    def test_recovered_pagination_error_keeps_existing_success_behavior(self):
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        sync.init_db(connection)
        output = io.StringIO()
        error = urllib.error.HTTPError(CANARY, 503, CANARY, {}, None)
        calls = []

        @diagnostics.staged("Nightscout fetch")
        def fetch(_):
            calls.append(True)
            if len(calls) == 1:
                return [{"date": 1, "sgv": 100}]
            raise error

        with patch.object(sync, "PAGE", 1), patch.object(sync, "ns_get", fetch):
            with contextlib.redirect_stderr(output):
                self.assertEqual(sync.page_entries(connection), 1)
        self.record(output.getvalue(), "Nightscout fetch", "http_5xx")
        connection.close()


if __name__ == "__main__":
    unittest.main()
