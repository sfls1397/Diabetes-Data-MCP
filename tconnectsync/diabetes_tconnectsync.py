#!/usr/bin/env python3
import logging
import os
import sys
from datetime import timedelta
from contextlib import redirect_stderr, redirect_stdout
from contextvars import ContextVar
from functools import wraps
from io import StringIO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import combo_bolus
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sync"))
from failure_diagnostics import category, http_category, report, staged

if __name__ == "__main__":
    sys.excepthook = lambda error_type, error, traceback: report(error, stage="startup")

SUPPORTED_VERSION = "3.0.3"
CATCH_UP_FLAG = "--catch-up"
CATCH_UP_MAX_DAYS = 28
log = logging.getLogger("diabetes.combo_bolus")
current_completion = ContextVar("diabetes_completion", default=None)


class AuthLogFilter(logging.Filter):
    def filter(self, record):
        if record.levelno < logging.WARNING:
            return False
        record.msg = 'Tandem authentication: %s' % record.levelname.lower()
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


class PumpLogFilter(logging.Filter):
    def filter(self, record):
        record.msg = 'Tandem pump selection: %s' % record.levelname.lower()
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def install():
    from importlib.metadata import version

    installed = version("tconnectsync")
    if installed != SUPPORTED_VERSION:
        msg = "COMBO PATCH NOT APPLIED: tconnectsync %s, mapping written for %s" % (installed, SUPPORTED_VERSION)
        logging.getLogger().warning(msg)
        print(msg, file=sys.stderr)
        return False
    from tconnectsync.sync.tandemsource import process_bolus
    auth_log = logging.getLogger('tconnectsync.api.tandemsource')
    if not any(isinstance(item, AuthLogFilter) for item in auth_log.filters):
        auth_log.addFilter(AuthLogFilter())
    pump_log = logging.getLogger('tconnectsync.sync.tandemsource.choose_device')
    if not any(isinstance(item, PumpLogFilter) for item in pump_log.filters):
        pump_log.addFilter(PumpLogFilter())

    if getattr(process_bolus.ProcessBolus.process, "_diabetes_combo", False):
        return True
    stock = process_bolus.ProcessBolus.process

    def process(self, events, time_start, time_end):
        events = list(events)
        return combo_bolus.apply_to_entries(stock(self, events, time_start, time_end), events)

    process._diabetes_combo = True
    process.__wrapped__ = stock
    process_bolus.ProcessBolus.process = process
    return True


@staged("startup")
def startup():
    output, errors = StringIO(), StringIO()
    with redirect_stdout(output), redirect_stderr(errors):
        active = install()
        if active:
            install_diagnostics()
    sys.stdout.write(output.getvalue())
    sys.stderr.write(errors.getvalue())
    return active


def catch_up_window(watermark, now, max_days=CATCH_UP_MAX_DAYS):
    if watermark is not None and watermark >= now - timedelta(days=1):
        return None
    floor = now - timedelta(days=max_days)
    return floor if watermark is None or watermark < floor else watermark


def oldest_pump_watermark(nightscout, now, max_days=CATCH_UP_MAX_DAYS):
    from tconnectsync.parser.nightscout import BASAL_EVENTTYPE, BOLUS_EVENTTYPE
    import arrow

    since = now - timedelta(days=max_days)
    oldest = None
    for event_type in (BASAL_EVENTTYPE, BOLUS_EVENTTYPE):
        row = nightscout.last_uploaded_entry(event_type, time_start=since)
        if row and row.get("created_at"):
            created = arrow.get(row["created_at"])
            oldest = created if oldest is None else min(oldest, created)
    return oldest


def catch_up_arguments(argv):
    if CATCH_UP_FLAG not in argv[1:]:
        return argv
    rest = [argv[0]] + [item for item in argv[1:] if item != CATCH_UP_FLAG]
    import arrow
    from tconnectsync.nightscout import NightscoutApi
    from tconnectsync import secret

    zone = secret.TIMEZONE_NAME
    now = arrow.utcnow()
    nightscout = NightscoutApi(secret.NS_URL, secret.NS_SECRET,
                               skip_verify=secret.NS_SKIP_TLS_VERIFY,
                               ignore_conn_errors=False)
    start = catch_up_window(oldest_pump_watermark(nightscout, now), now)
    if start is None:
        start = now - timedelta(days=1)
    else:
        print("Catching up: a Nightscout pump type is older than a day; reading Tandem Source from %s"
              % start.to(zone).isoformat(), file=sys.stderr)
    start = start.to(zone)
    return rest + ["--start-date", start.isoformat(), "--end-date", now.to(zone).isoformat()]


class SyncCompletion(logging.Filter):
    def __init__(self):
        super().__init__()
        self.one_shot = False
        self.zero_events = False
        self.failed = False
        self.profiles_compared = False

    def filter(self, record):
        if record.levelno >= logging.ERROR:
            self.failed = True
        return True


def track_completion(original, *, profile_comparison):
    from tconnectsync.features import PROFILES

    @wraps(original)
    def process(*args, **kwargs):
        result = original(*args, **kwargs)
        completion = current_completion.get()
        if completion is not None and completion.one_shot:
            if profile_comparison:
                completion.profiles_compared = True
            else:
                completion.zero_events = result[0] == 0 and (
                    PROFILES not in args[0].features or completion.profiles_compared)
        return result
    return process


def main():
    phase = "startup"
    active = False
    completion = SyncCompletion()
    completion_token = current_completion.set(completion)
    profile_log = logging.getLogger("tconnectsync.sync.tandemsource.update_profiles")
    try:
        active = startup()
        if "--combo-selftest" in sys.argv:
            print("combo patch %s for tconnectsync %s" % ("loaded" if active else "NOT loaded", SUPPORTED_VERSION))
            return 0 if active else 1
        phase = "sync completion"
        sys.argv = catch_up_arguments(sys.argv)
        if active:
            profile_log.addFilter(completion)
        from tconnectsync import main as tconnect_main
        result = tconnect_main()
        if result:
            report(stage="sync completion", kind="unknown")
        return result
    except SystemExit as error:
        argument_failure = getattr(error, "_diabetes_argument_failure", False)
        if (active and not argument_failure and type(error.code) is int and error.code == 1
                and completion.zero_events and not completion.failed):
            return 0
        if error.code:
            report(stage="startup" if argument_failure else phase,
                   kind="parse" if argument_failure else "unknown")
        if error.code is not None and not isinstance(error.code, int):
            raise SystemExit(1) from None
        raise
    except Exception as error:
        report(error, kind=category(error) if phase == "startup" else tandem_category(error))
        return 1
    finally:
        profile_log.removeFilter(completion)
        current_completion.reset(completion_token)


def protected_arguments(original):
    @wraps(original)
    def parse(*args, **kwargs):
        output, errors = StringIO(), StringIO()
        try:
            with redirect_stdout(output), redirect_stderr(errors):
                parsed = original(*args, **kwargs)
        except SystemExit as error:
            if error.code:
                error._diabetes_argument_failure = True
            else:
                sys.stdout.write(output.getvalue())
                sys.stderr.write(errors.getvalue())
            raise
        sys.stdout.write(output.getvalue())
        sys.stderr.write(errors.getvalue())
        completion = current_completion.get()
        if completion is not None:
            completion.one_shot = not (parsed.auto_update or parsed.check_login)
        return parsed
    parse._diabetes_diagnostics = True
    return parse


class RecoveredConnectionLogger(logging.LoggerAdapter):
    def warning(self, message, *args, **kwargs):
        if message == "Ignoring ConnectionError because ignore_conn_errors=true" and args:
            completion = current_completion.get()
            if completion is not None:
                completion.failed = True
            report(stage="Nightscout fetch", kind=tandem_category(args[0]))
            return
        return self.logger.warning(message, *args, **kwargs)

    warn = warning


class AutoUpdateLogger(logging.LoggerAdapter):
    def log(self, level, message, *args, **kwargs):
        error = sys.exc_info()[1]
        if level >= logging.WARNING and (error is not None or isinstance(message, Exception)):
            error = error if error is not None else message
            report(error, stage=vars(error).get("_diabetes_failure_stage", "Tandem fetch"),
                   kind=tandem_category(error))
            return
        return super().log(level, message, *args, **kwargs)


def tandem_category(error):
    try:
        import requests
        import jwt
        from tconnectsync.api.common import ApiException, ApiLoginException
    except ImportError:
        return category(error)

    if isinstance(error, requests.exceptions.Timeout):
        return "timeout"
    if isinstance(error, (ApiLoginException, jwt.InvalidTokenError)):
        return "auth"
    if isinstance(error, ApiException):
        return http_category(error.status_code)
    if isinstance(error, requests.exceptions.HTTPError):
        return http_category(error.response.status_code if error.response is not None else None)
    if isinstance(error, requests.exceptions.ConnectionError):
        return "transport"
    if isinstance(error, (requests.exceptions.ChunkedEncodingError, requests.exceptions.RetryError)):
        return "transport"
    return category(error)


def install_diagnostics():
    import tconnectsync
    import tconnectsync.nightscout as nightscout
    import tconnectsync.sync.tandemsource.autoupdate as autoupdate
    from tconnectsync.api.tandemsource import TandemSourceApi
    from tconnectsync.nightscout import NightscoutApi
    from tconnectsync.sync.tandemsource.process import ProcessTimeRange
    from tconnectsync.sync.tandemsource.update_profiles import UpdateProfiles

    if not getattr(tconnectsync.parse_args, "_diabetes_diagnostics", False):
        tconnectsync.parse_args = protected_arguments(tconnectsync.parse_args)
    if not isinstance(nightscout.logger, RecoveredConnectionLogger):
        nightscout.logger = RecoveredConnectionLogger(nightscout.logger, {})
    if not isinstance(autoupdate.logger, AutoUpdateLogger):
        autoupdate.logger = AutoUpdateLogger(autoupdate.logger, {})

    groups = (
        (TandemSourceApi, "Tandem auth", ("__init__", "login", "extract_jwt")),
        (TandemSourceApi, "Tandem fetch", ("_get", "get", "get_pump_logs", "get_pumper")),
        (NightscoutApi, "Nightscout fetch", ("last_uploaded_entry", "last_uploaded_bg_entry",
            "last_uploaded_activity", "last_uploaded_devicestatus", "api_status", "current_profile")),
        (NightscoutApi, "Nightscout upload", ("upload_entry", "put_entry", "delete_entry")),
        (ProcessTimeRange, "Tandem parse", ("process",)),
        (UpdateProfiles, "Tandem parse", ("compare_profiles",)),
    )
    for owner, name, methods in groups:
        for method in methods:
            original = getattr(owner, method)
            if not getattr(original, "_diabetes_diagnostics", False):
                wrapped = staged(name)(original)
                if owner in (ProcessTimeRange, UpdateProfiles):
                    wrapped = track_completion(wrapped, profile_comparison=owner is UpdateProfiles)
                wrapped._diabetes_diagnostics = True
                setattr(owner, method, wrapped)


if __name__ == "__main__":
    sys.exit(main())
