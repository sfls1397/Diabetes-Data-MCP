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
    install()
    from tconnectsync import main as tconnect_main

    try:
        return tconnect_main()
    except Exception:
        # API exceptions may contain the raw authentication response. Keep the
        # scheduled job nonzero without serializing it or a credential traceback.
        print('Tandem sync failed; private response details omitted', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
