#!/usr/bin/env python3
"""Run tconnectsync with the combo-bolus mapping applied at import time.

Used by tconnectsync/diabetes-tconnectsync instead of the stock console script. Nothing
in site-packages is edited, so `pip install` can never silently drop the mapping; if the
installed tconnectsync is not the pinned version the mapping is NOT applied and a loud
WARNING is logged (uploads continue as stock).

    diabetes_tconnectsync.py --combo-selftest   verify the hook loads, then exit
    diabetes_tconnectsync.py [tconnectsync args]
"""
import logging
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from contextvars import ContextVar
from functools import wraps
from io import StringIO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import combo_bolus  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sync"))
from failure_diagnostics import category, http_category, report, staged

if __name__ == "__main__":
    sys.excepthook = lambda error_type, error, traceback: report(error, stage="startup")

SUPPORTED_VERSION = "3.0.3"
log = logging.getLogger("diabetes.combo_bolus")
current_completion = ContextVar("diabetes_completion", default=None)


class AuthLogFilter(logging.Filter):
    """The upstream API logs decoded tokens and raw authentication responses."""
    def filter(self, record):
        if record.levelno < logging.WARNING:
            return False
        record.msg = 'Tandem authentication: %s' % record.levelname.lower()
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def install():
    """Hook ProcessBolus.process. Returns True when the mapping is active."""
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


class CompletionDiagnosticFilter(logging.Filter):
    def __init__(self):
        super().__init__()
        self.emitted = False
        self.auto_update = False

    def filter(self, record):
        if (not self.emitted and not self.auto_update
                and record.levelno == logging.INFO and isinstance(record.msg, str)
                and re.fullmatch(r"Processed 0 events\. Last event ID seen: -?\d+", record.msg)):
            report(stage="sync completion", kind="unknown")
            self.emitted = True
        return True


def main():
    phase = "startup"
    completion = CompletionDiagnosticFilter()
    completion_token = current_completion.set(completion)
    process_log = logging.getLogger("tconnectsync.sync.tandemsource.process")
    try:
        active = startup()
        if "--combo-selftest" in sys.argv:
            print("combo patch %s for tconnectsync %s" % ("loaded" if active else "NOT loaded", SUPPORTED_VERSION))
            return 0 if active else 1
        phase = "sync completion"
        if active:
            process_log.addFilter(completion)
        from tconnectsync import main as tconnect_main
        result = tconnect_main()
        if result and not completion.emitted:
            report(stage="sync completion", kind="unknown")
        return result
    except SystemExit as error:
        if error.code and not completion.emitted:
            argument_failure = getattr(error, "_diabetes_argument_failure", False)
            report(stage="startup" if argument_failure else phase,
                   kind="parse" if argument_failure else "unknown")
        if error.code is not None and not isinstance(error.code, int):
            raise SystemExit(1) from None
        raise
    except Exception as error:
        report(error, kind=category(error) if phase == "startup" else tandem_category(error))
        return 1
    finally:
        process_log.removeFilter(completion)
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
            completion.auto_update = parsed.auto_update
        return parsed
    parse._diabetes_diagnostics = True
    return parse


class RecoveredConnectionLogger(logging.LoggerAdapter):
    def warning(self, message, *args, **kwargs):
        if message == "Ignoring ConnectionError because ignore_conn_errors=true" and args:
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
    )
    for owner, name, methods in groups:
        for method in methods:
            original = getattr(owner, method)
            if not getattr(original, "_diabetes_diagnostics", False):
                wrapped = staged(name)(original)
                wrapped._diabetes_diagnostics = True
                setattr(owner, method, wrapped)


if __name__ == "__main__":
    sys.exit(main())
