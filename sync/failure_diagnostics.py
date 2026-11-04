"""Fixed-vocabulary diagnostics: never serialize an exception or its arguments."""
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
import json
import sqlite3
import subprocess
import sys
import urllib.error


STAGES = frozenset((
    "startup", "credential lookup", "Nightscout fetch", "Nightscout parse",
    "Nightscout upload", "SQLite open", "SQLite write", "SQLite commit",
    "SQLite stats", "sync lock", "Tandem auth", "Tandem fetch", "Tandem parse",
    "sync completion", "unknown",
))
CATEGORIES = frozenset((
    "timeout", "http_4xx", "http_5xx", "http_other", "auth", "db", "parse",
    "transport", "unknown",
))


@contextmanager
def failure_stage(name):
    try:
        yield
    except Exception as error:
        if "_diabetes_failure_stage" not in vars(error):
            vars(error)["_diabetes_failure_stage"] = name if name in STAGES else "unknown"
        raise


def staged(name):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with failure_stage(name):
                return function(*args, **kwargs)
        return wrapped
    return decorate


def http_category(status):
    if type(status) is not int:
        return "unknown"
    if status in (401, 403):
        return "auth"
    if 400 <= status < 500:
        return "http_4xx"
    if 500 <= status < 600:
        return "http_5xx"
    return "http_other"


def category(error):
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        return "timeout"
    if isinstance(error, urllib.error.HTTPError):
        return http_category(error.code)
    if isinstance(error, urllib.error.URLError):
        return "timeout" if isinstance(error.reason, TimeoutError) else "transport"
    if isinstance(error, sqlite3.Error):
        return "db"
    if isinstance(error, (ValueError, UnicodeError, json.JSONDecodeError)):
        return "parse"
    if isinstance(error, OSError):
        return "transport"
    return "unknown"


def diagnostic(error=None, *, stage=None, kind=None):
    name = stage or (vars(error).get("_diabetes_failure_stage", "unknown") if error is not None else "unknown")
    value = kind or category(error)
    return json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "category": value if value in CATEGORIES else "unknown",
        "stage": name if name in STAGES else "unknown",
    }, separators=(",", ":"))


def report(error=None, *, stage=None, kind=None):
    line = diagnostic(error, stage=stage, kind=kind)
    print(line, file=sys.stderr)
    return line


if __name__ == "__main__":
    report(stage=sys.argv[1] if len(sys.argv) > 1 else None,
           kind=sys.argv[2] if len(sys.argv) > 2 else None)
