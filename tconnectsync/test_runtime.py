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
from unittest.mock import Mock, patch
from contextlib import nullcontext, redirect_stderr
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

    def test_locked_html_and_oauth_libraries_work_offline(self):
        from bs4 import BeautifulSoup
        from requests_oauthlib import OAuth2Session
        page = '<form><input name="csrf" value="fixture"></form><div><ul><li><span>z</span></li></ul></div>'
        for parser in ['html.parser', 'lxml']:
            soup = BeautifulSoup(page, parser)
            self.assertEqual(soup.select_one('input[name=csrf]')['value'], 'fixture')
            self.assertEqual(len(soup.select('div:has(> ul) li span')), 1)
        url, _ = OAuth2Session('fixture-client', redirect_uri='https://fixture.invalid/cb',
                               scope='openid').authorization_url('https://fixture.invalid/authorize')
        self.assertIn('client_id=fixture-client', url)
        self.assertIn('response_type=code', url)

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

    def run_sync_fixture(self, *, count=0, events_present=False, choose_error=None,
                         write_error=None, partial=None, args=(), supported=True):
        import arrow
        import requests
        from tconnectsync.nightscout import NightscoutApi
        from tconnectsync.sync.tandemsource.process import EventClass, ProcessTimeRange

        output = StringIO()
        logger = logging.getLogger('tconnectsync.sync.tandemsource.process')
        old_level, old_propagate = logger.level, logger.propagate
        handler = logging.StreamHandler(output)
        handler.setFormatter(logging.Formatter('2026-11-03 14:35:12 INFO %(message)s'))
        events = [SimpleNamespace(eventTimestamp=arrow.get('2026-11-03T20:00:00Z'), seqNum=42)] if events_present else []
        chooser = SimpleNamespace(choose=Mock(return_value={'assignmentId': 'fixture'}, side_effect=choose_error))
        processor = Mock()
        processor.write.return_value = count
        processor.write.side_effect = write_error
        nightscout = NightscoutApi('https://fixture.invalid', 'fixture', ignore_conn_errors=True)
        updater = Mock()

        def pump_events(*_, **__):
            if partial == 'nightscout':
                nightscout.last_uploaded_entry('fixture')
            return events

        def update_profile(_):
            logging.getLogger('tconnectsync.sync.tandemsource.update_profiles').error(
                'No current pump profile, so skipping profile update')
            return False

        def auto_update(tconnect, nightscout, pretend, features):
            import tconnectsync
            ProcessTimeRange(tconnect, nightscout, chooser.choose(), pretend, tconnectsync.secret, features).process(
                arrow.get('2026-11-03T19:00:00Z'), arrow.get('2026-11-03T21:00:00Z'))
            return 1

        updater.update.side_effect = update_profile
        updater_classes = [Mock(__name__='FixtureUpdater', return_value=updater)] if partial == 'profile' else []
        version = nullcontext() if supported else patch('importlib.metadata.version', return_value='99.0.0')
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        try:
            logging.disable(logging.NOTSET)
            with patch('sys.argv', ['fixture', *args]), redirect_stderr(output), version, \
                    patch('socket.socket.connect', side_effect=AssertionError('offline fixture')), \
                    patch('tconnectsync.nightscout.requests.get', side_effect=requests.ConnectionError('fixture-private-token')), \
                    patch('tconnectsync.TConnectApi', return_value=SimpleNamespace(tandemsource=SimpleNamespace(pump_events=pump_events))), \
                    patch('tconnectsync.NightscoutApi', return_value=nightscout), \
                    patch('tconnectsync.TandemSourceChooseDevice', return_value=chooser), \
                    patch('tconnectsync.TandemSourceAutoupdate', return_value=SimpleNamespace(process=auto_update)), \
                    patch.object(EventClass, 'for_event', return_value=SimpleNamespace(name='FIXTURE')), \
                    patch.object(ProcessTimeRange, 'event_classes', {'FIXTURE': Mock(return_value=processor)}), \
                    patch.object(ProcessTimeRange, 'updater_classes', updater_classes):
                try:
                    status = diabetes_tconnectsync.main()
                except SystemExit as error:
                    status = error.code
        finally:
            logging.disable(logging.CRITICAL)
            logger.removeHandler(handler)
            logger.setLevel(old_level)
            logger.propagate = old_propagate
        return status, output.getvalue().splitlines()

    def test_one_shot_sync_completion_event_counts(self):
        for count, events_present, last in [(0, False, -1), (0, True, 42), (1, True, 42), (70, True, 42)]:
            with self.subTest(count=count, events_present=events_present):
                status, lines = self.run_sync_fixture(count=count, events_present=events_present)
                self.assertEqual(status, 0)
                self.assertFalse(any(line.startswith('{') for line in lines))
                self.assertEqual(lines[-1], f'2026-11-03 14:35:12 INFO Processed {count} events. Last event ID seen: {last}')

    def test_one_shot_sync_failures_are_not_empty_successes(self):
        from tconnectsync.api.common import ApiException, ApiLoginException

        cases = [({'choose_error': ApiLoginException(401, 'fixture-private-token')}, 'auth', False),
                 ({'events_present': True, 'write_error': ApiException(503, 'fixture-private-token')}, 'http_5xx', False),
                 ({'partial': 'nightscout', 'args': ('--verbose',)}, 'transport', True),
                 ({'partial': 'profile'}, 'unknown', True),
                 ({'args': ('--auto-u',)}, 'unknown', True),
                 ({'supported': False}, 'unknown', True)]
        for options, category, terminal in cases:
            with self.subTest(options=options):
                status, lines = self.run_sync_fixture(**options)
                self.assertEqual(status, 1)
                records = [json.loads(line) for line in lines if line.startswith('{')]
                self.assertIn(category, [record['category'] for record in records])
                self.assertEqual(any('Processed 0 events.' in line for line in lines), terminal)
                self.assertNotIn('fixture-private-token', '\n'.join(lines))

    def test_completion_log_alone_does_not_change_exit_status(self):
        import tconnectsync
        logger = logging.getLogger('tconnectsync.sync.tandemsource.process')

        def premature_exit():
            tconnectsync.parse_args()
            logger.info('Processed 0 events. Last event ID seen: -1')
            raise SystemExit(1)

        logging.disable(logging.NOTSET)
        try:
            with patch('sys.argv', ['fixture']), patch('tconnectsync.main', side_effect=premature_exit), \
                    redirect_stderr(StringIO()), self.assertLogs(logger, level='INFO') as log, \
                    self.assertRaises(SystemExit) as result:
                diabetes_tconnectsync.main()
        finally:
            logging.disable(logging.CRITICAL)
        self.assertIn('Processed 0 events.', log.output[0])
        self.assertEqual(result.exception.code, 1)

    def test_advisory_outage_blocks(self):
        with patch.object(audit.urllib.request, 'urlopen', side_effect=OSError('fixture outage')):
            with self.assertRaises(OSError):
                audit.findings({'pyjwt': '2.8.0'})

    def test_real_auto_update_retry_logs_are_private_without_changing_backoff(self):
        import requests
        import tconnectsync
        import tconnectsync.sync.tandemsource.autoupdate as autoupdate
        from tconnectsync.api.common import ApiException
        errors = [ApiException(503, 'fixture-private-token'),
                  requests.exceptions.ConnectionError('fixture-private-token'),
                  requests.exceptions.Timeout('fixture-private-token'),
                  requests.exceptions.ChunkedEncodingError('fixture-private-token'),
                  requests.exceptions.RetryError('fixture-private-token')]
        logger = logging.getLogger(autoupdate.__name__)
        for error in errors:
            for disabled in [logging.NOTSET, logging.CRITICAL]:
                output = StringIO()
                old_level, old_propagate = logger.level, logger.propagate
                handler = logging.StreamHandler(output)
                logger.addHandler(handler)
                logger.setLevel(logging.WARNING)
                logger.propagate = False
                secret = SimpleNamespace(AUTOUPDATE_MAX_LOOP_INVOCATIONS=3,
                    AUTOUPDATE_API_FAILURE_MINUTES=0, AUTOUPDATE_DEFAULT_SLEEP_SECONDS=300)
                instance = autoupdate.TandemSourceAutoupdate(secret)
                api = TandemSourceApi.__new__(TandemSourceApi)
                def fail(_self):
                    raise error
                def cycle():
                    self.assertTrue(tconnectsync.parse_args().auto_update)
                    return instance.process(SimpleNamespace(tandemsource=api), None, False)
                try:
                    logging.disable(disabled)
                    with patch.object(TandemSourceApi, 'get_pumper', fail), \
                            patch.object(autoupdate.time, 'sleep') as sleep, \
                            patch('tconnectsync.main', side_effect=cycle), \
                            patch('sys.argv', ['fixture', '--auto']), redirect_stderr(output):
                        self.assertEqual(diabetes_tconnectsync.main(), 0)
                    self.assertEqual([call.args[0] for call in sleep.call_args_list], [30, 60, 120])
                    self.assertEqual(instance.autoupdate_invocations, 3)
                    self.assertEqual(instance.consecutive_failures, 3)
                finally:
                    logging.disable(logging.CRITICAL)
                    logger.removeHandler(handler)
                    logger.setLevel(old_level)
                    logger.propagate = old_propagate
                self.assertNotIn('fixture-private-token', output.getvalue())
                records = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(len(records), 3)
                for record in records:
                    self.assertEqual(set(record), {'timestamp', 'category', 'stage'})
                    self.assertEqual(record['stage'], 'Tandem fetch')
                    expected = 'http_5xx' if isinstance(error, ApiException) else 'timeout' if isinstance(error, requests.exceptions.Timeout) else 'transport'
                    self.assertEqual(record['category'], expected)

    def test_invalid_arguments_are_private_and_help_remains_available(self):
        for arguments in [['--days', 'fixture-private-token'], ['--region', 'fixture-private-token'],
                          ['--fixture-private-token'], ['--features', 'fixture-private-token']]:
            result = subprocess.run([sys.executable, diabetes_tconnectsync.__file__, *arguments],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn('fixture-private-token', result.stdout + result.stderr)
            record = json.loads(result.stderr)
            self.assertEqual(set(record), {'timestamp', 'category', 'stage'})
            self.assertEqual((record['category'], record['stage']), ('parse', 'startup'))
        for argument in ['--help', '--version']:
            result = subprocess.run([sys.executable, diabetes_tconnectsync.__file__, argument],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn('tconnectsync', result.stdout)
            self.assertEqual(result.stderr, '')

    def test_auto_update_fatal_auth_budget_and_recovery_remain_unchanged(self):
        import tconnectsync
        import tconnectsync.secret as secret
        import tconnectsync.sync.tandemsource.autoupdate as autoupdate
        from tconnectsync.api.common import ApiException, ApiLoginException
        diabetes_tconnectsync.install_diagnostics()
        for mode in ['auth', 'budget', 'recovery']:
            output = StringIO()
            instance = autoupdate.TandemSourceAutoupdate(SimpleNamespace(**{
                **vars(secret), 'AUTOUPDATE_MAX_LOOP_INVOCATIONS': 2,
                'AUTOUPDATE_API_FAILURE_MINUTES': 1 if mode == 'budget' else 0,
                'AUTOUPDATE_DEFAULT_SLEEP_SECONDS': 300, 'AUTOUPDATE_USE_FIXED_SLEEP': 1}))
            calls = []
            api = TandemSourceApi.__new__(TandemSourceApi)
            def fetch(_self):
                calls.append(1)
                if mode == 'auth':
                    raise ApiLoginException(401, 'fixture-private-token')
                if len(calls) == 1 or mode == 'budget':
                    raise ApiException(503, 'fixture-private-token')
                return {'pumps': [{'assignmentId': 'fixture', 'serialNumber': '11111111',
                                   'maxDateOfEvents': '2026-11-03T12:00:00Z'}]}
            def cycle():
                tconnectsync.parse_args()
                return instance.process(SimpleNamespace(tandemsource=api), None, False)
            clock = iter([0, 1, 1, 121]) if mode == 'budget' else None
            with patch.object(TandemSourceApi, 'get_pumper', fetch), \
                    patch.object(autoupdate.time, 'sleep') as sleep, \
                    patch.object(autoupdate.time, 'time', side_effect=lambda: next(clock) if clock else 1), \
                    patch.object(autoupdate.ProcessTimeRange, 'process', return_value=(1, 1)), \
                    patch('tconnectsync.main', side_effect=cycle), \
                    patch('sys.argv', ['fixture', '--auto-update']), redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 0 if mode == 'recovery' else 1)
            self.assertEqual([call.args[0] for call in sleep.call_args_list],
                             [] if mode == 'auth' else [30] if mode == 'budget' else [30, 300])
            self.assertEqual(len(calls), 2 if mode == 'recovery' else 1)
            if mode == 'recovery':
                self.assertEqual(instance.consecutive_failures, 0)
                self.assertIsNone(instance.first_failure_time)
            self.assertNotIn('fixture-private-token', output.getvalue())
            records = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertGreaterEqual(len(records), 1)
            self.assertEqual(records[0]['stage'], 'Tandem fetch')
            self.assertEqual(records[0]['category'], 'auth' if mode == 'auth' else 'http_5xx')

    def test_recovered_nightscout_errors_emit_diagnostics_even_with_logging_disabled(self):
        from tconnectsync.nightscout import NightscoutApi
        import requests
        diabetes_tconnectsync.install_diagnostics()
        for method in ['last_uploaded_entry', 'last_uploaded_bg_entry',
                       'last_uploaded_activity', 'last_uploaded_devicestatus']:
            for disabled in [logging.NOTSET, logging.CRITICAL]:
                with self.subTest(method=method, disabled=disabled):
                    output = StringIO()
                    instance = NightscoutApi('https://fixture.invalid', 'fixture-private-token', ignore_conn_errors=True)
                    def fetch():
                        arguments = ['fixture'] if method in ['last_uploaded_entry', 'last_uploaded_activity'] else []
                        self.assertIsNone(getattr(instance, method)(*arguments))
                        return 0
                    try:
                        logging.disable(disabled)
                        with patch('tconnectsync.nightscout.requests.get', side_effect=requests.exceptions.ConnectionError('fixture-private-token')), \
                                patch('tconnectsync.main', side_effect=fetch), patch('sys.argv', ['fixture']), redirect_stderr(output):
                            self.assertEqual(diabetes_tconnectsync.main(), 0)
                    finally:
                        logging.disable(logging.CRITICAL)
                    record = json.loads(output.getvalue())
                    self.assertEqual(set(record), {'timestamp', 'category', 'stage'})
                    self.assertEqual((record['category'], record['stage']), ('transport', 'Nightscout fetch'))
                    self.assertNotIn('fixture-private-token', output.getvalue())

    def test_parsed_auto_update_abbreviations_do_not_report_zero_event_failure(self):
        import tconnectsync
        logger = logging.getLogger('tconnectsync.sync.tandemsource.process')
        for argument in ['--auto-update', '--auto', '--auto-u', '--a']:
            output = StringIO()
            old_level, old_propagate = logger.level, logger.propagate
            handler = logging.StreamHandler(output)
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
            logger.propagate = False
            def cycle():
                self.assertTrue(tconnectsync.parse_args().auto_update)
                logger.info('Processed 0 events. Last event ID seen: -1')
                return 0
            try:
                logging.disable(logging.NOTSET)
                with patch('sys.argv', ['fixture', argument]), patch('tconnectsync.main', side_effect=cycle), redirect_stderr(output):
                    self.assertEqual(diabetes_tconnectsync.main(), 0)
            finally:
                logging.disable(logging.CRITICAL)
                logger.removeHandler(handler)
                logger.setLevel(old_level)
                logger.propagate = old_propagate
            self.assertEqual(output.getvalue().strip(), 'Processed 0 events. Last event ID seen: -1')

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

    def test_catch_up_window_is_one_day_unless_the_pump_row_is_older(self):
        import arrow
        now = arrow.get('2026-11-08T07:35:00+00:00')
        window = diabetes_tconnectsync.catch_up_window
        self.assertIsNone(window(now.shift(hours=-2), now))
        self.assertIsNone(window(now.shift(days=-1), now))
        stalled = now.shift(days=-3, hours=-13)
        self.assertEqual(window(stalled, now), stalled)
        self.assertEqual(window(now.shift(days=-40), now), now.shift(days=-28))
        self.assertEqual(window(None, now), now.shift(days=-28))

    def catch_up(self, argv, rows):
        """Run catch_up_arguments against a fake Nightscout; return (argv, stderr, urls)."""
        from tconnectsync import secret
        urls = []

        def get(url, **_):
            urls.append(url)
            event_type = 'Temp Basal' if 'Temp%20Basal' in url else 'Combo Bolus'
            row = rows.get(event_type)
            return SimpleNamespace(status_code=200, json=lambda: [row] if row else [])

        output = StringIO()
        with patch('tconnectsync.nightscout.requests.get', side_effect=get), \
                patch.object(secret, 'NS_URL', 'https://fixture.invalid/'), \
                patch.object(secret, 'NS_SECRET', 'fixture-private-token'), \
                patch.object(secret, 'TIMEZONE_NAME', 'America/Chicago'), \
                redirect_stderr(output):
            result = diabetes_tconnectsync.catch_up_arguments(argv)
        return result, output.getvalue(), urls

    def test_catch_up_arguments_heal_a_stalled_pump_and_stay_one_day_otherwise(self):
        import arrow
        features = ['--features', 'BASAL', 'BOLUS', 'PUMP_EVENTS', 'PROFILES']
        argv = ['fixture', '--catch-up'] + features
        recent = arrow.utcnow().shift(minutes=-50).isoformat()
        result, output, urls = self.catch_up(argv, {'Temp Basal': {'created_at': recent}})
        self.assertEqual(result[:-4], ['fixture'] + features)
        self.assertEqual(result[-4], '--start-date')
        self.assertEqual(result[-2], '--end-date')
        self.assertTrue(result[-3].endswith(('-06:00', '-05:00')))
        self.assertAlmostEqual((arrow.get(result[-1]) - arrow.get(result[-3])).total_seconds(), 86400)
        self.assertEqual(output, '')
        # The date filter keeps the lookup outside Nightscout's default ~96 h window.
        self.assertEqual(len(urls), 2)
        self.assertTrue(all('find[created_at][$gte]=' in url for url in urls))
        self.assertTrue(all('fixture-private-token' not in url for url in urls))

        basal = arrow.utcnow().shift(days=-3, hours=-13)
        bolus = basal.shift(hours=-2)
        result, output, _ = self.catch_up(argv, {'Temp Basal': {'created_at': basal.isoformat()},
                                                 'Combo Bolus': {'created_at': bolus.isoformat()}})
        self.assertEqual(result[:-4], ['fixture'] + features)
        self.assertEqual(result[-4], '--start-date')
        self.assertEqual(arrow.get(result[-3]), bolus)
        self.assertTrue(result[-3].endswith(('-06:00', '-05:00')))
        self.assertEqual(result[-2], '--end-date')
        self.assertLess(abs((arrow.get(result[-1]) - arrow.utcnow()).total_seconds()), 60)
        self.assertIn('Catching up', output)
        self.assertNotIn('fixture-private-token', output)

        result, _, _ = self.catch_up(argv, {})
        self.assertLess(abs((arrow.get(result[-3]) - arrow.utcnow().shift(days=-28)).total_seconds()), 60)

        # Without the flag (hand runs, recipes) the arguments pass through untouched.
        result, output, urls = self.catch_up(['fixture', '--days', '1'], {})
        self.assertEqual((result, output, urls), (['fixture', '--days', '1'], '', []))

    def test_catch_up_includes_the_lagging_type_and_uses_utc_across_dst(self):
        import arrow
        for instant in ['2026-11-02T07:35:00Z', '2026-03-09T07:35:00Z']:
            now = arrow.get(instant)
            for lagging_type in ['Temp Basal', 'Combo Bolus']:
                rows = {kind: {'created_at': now.shift(hours=-2).isoformat()}
                        for kind in ['Temp Basal', 'Combo Bolus']}
                rows[lagging_type]['created_at'] = now.shift(days=-4).isoformat()
                with patch('arrow.utcnow', return_value=now):
                    result, _, _ = self.catch_up(['fixture', '--catch-up', '--pretend'], rows)
                self.assertEqual(arrow.get(result[-3]), now.shift(days=-4))
                self.assertEqual(arrow.get(result[-1]), now)
                with patch('arrow.utcnow', return_value=now):
                    result, _, _ = self.catch_up(['fixture', '--catch-up'], {})
                self.assertEqual((now - arrow.get(result[-3])).total_seconds(), 28 * 86400)

    def test_device_choice_logs_mask_serials_and_device_metadata(self):
        diabetes_tconnectsync.install()
        logger = logging.getLogger('tconnectsync.sync.tandemsource.choose_device')
        for message in ["Found 1 pumps: dict_keys(['fixture-serial'])",
                        'Using pump with serial: fixture-serial (deviceId: fixture-device)',
                        'Unknown device fixture-serial']:
            record = logging.LogRecord(logger.name, logging.INFO, '', 1, message, (), None)
            self.assertTrue(logger.filter(record))
            self.assertNotIn('fixture-serial', record.getMessage())
            self.assertNotIn('fixture-device', record.getMessage())
        process_record = logging.LogRecord('fixture', logging.INFO, '', 1, 'Processed 3 events', (), None)
        process_logger = logging.getLogger('tconnectsync.sync.tandemsource.process')
        self.assertTrue(process_logger.filter(process_record))
        self.assertEqual(process_record.getMessage(), 'Processed 3 events')

    def test_catch_up_flag_never_reaches_upstream_and_failures_stay_staged(self):
        seen = []

        def upstream():
            seen.append(list(sys.argv))
            return 0
        with patch('sys.argv', ['fixture', '--catch-up', '--features', 'BASAL']), \
                patch.object(diabetes_tconnectsync, 'catch_up_arguments',
                             side_effect=lambda argv: [argv[0], '--features', 'BASAL', '--days', '1']), \
                patch('tconnectsync.main', side_effect=upstream):
            self.assertEqual(diabetes_tconnectsync.main(), 0)
        self.assertEqual(seen, [['fixture', '--features', 'BASAL', '--days', '1']])

        from tconnectsync import secret
        diabetes_tconnectsync.install_diagnostics()
        output = StringIO()
        response = SimpleNamespace(status_code=503, text='fixture-private-token')
        with patch('tconnectsync.nightscout.requests.get', return_value=response), \
                patch.object(secret, 'NS_SECRET', 'fixture-private-token'), \
                patch('sys.argv', ['fixture', '--catch-up']), \
                patch('tconnectsync.main', side_effect=AssertionError('upstream must not run')):
            with redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 1)
        record = json.loads(output.getvalue())
        self.assertEqual(record['stage'], 'Nightscout fetch')
        self.assertEqual(record['category'], 'http_5xx')
        self.assertNotIn('fixture-private-token', output.getvalue())

    def test_catch_up_lookup_fails_closed_even_when_connection_errors_are_ignored(self):
        import requests
        from tconnectsync import secret
        diabetes_tconnectsync.install_diagnostics()
        output = StringIO()
        with patch('tconnectsync.nightscout.requests.get',
                   side_effect=requests.exceptions.ConnectionError('fixture-private-token')), \
                patch.object(secret, 'NS_IGNORE_CONN_ERRORS', True), \
                patch.object(secret, 'NS_SECRET', 'fixture-private-token'), \
                patch('sys.argv', ['fixture', '--catch-up']), \
                patch('tconnectsync.main', side_effect=AssertionError('no 28-day window on a failed lookup')):
            with redirect_stderr(output):
                self.assertEqual(diabetes_tconnectsync.main(), 1)
        record = json.loads(output.getvalue())
        self.assertEqual((record['stage'], record['category']), ('Nightscout fetch', 'transport'))
        self.assertNotIn('fixture-private-token', output.getvalue())


if __name__ == '__main__':
    unittest.main()
