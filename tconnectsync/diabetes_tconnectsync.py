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
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import combo_bolus  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sync"))
from failure_diagnostics import category, http_category, report, staged  # noqa: E402

if __name__ == "__main__":
    sys.excepthook = lambda error_type, error, traceback: report(error, stage="startup")

SUPPORTED_VERSION = "3.0.3"
log = logging.getLogger("diabetes.combo_bolus")


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


def main():
    if "--combo-selftest" in sys.argv:
        ok = install()
        print("combo patch %s for tconnectsync %s" % ("loaded" if ok else "NOT loaded", SUPPORTED_VERSION))
        return 0 if ok else 1
    try:
        if staged("startup")(install)():
            staged("startup")(install_diagnostics)()
        from tconnectsync import main as tconnect_main
        result = tconnect_main()
        if result:
            report(stage="sync completion", kind="unknown")
        return result
    except SystemExit as error:
        if error.code:
            report(stage="sync completion", kind="unknown")
        if error.code is not None and not isinstance(error.code, int):
            raise SystemExit(1) from None
        raise
    except Exception as error:
        report(error, kind=tandem_category(error))
        return 1


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
    return category(error)


def install_diagnostics():
    from tconnectsync.api.tandemsource import TandemSourceApi
    from tconnectsync.nightscout import NightscoutApi
    from tconnectsync.sync.tandemsource.process import ProcessTimeRange

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
