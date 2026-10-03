#!/usr/bin/env python3
"""Re-map combo boluses ALREADY in Nightscout into the combo shape (see combo_bolus.py).

tconnectsync only uploads new treatments, so a combo that landed before the mapping was
active stays plain. This re-reads Tandem Source for a date range, finds the true combos,
and replaces their Nightscout treatments (the immediate-dose entry and the redundant
extended-completion entry) with one combo treatment.

    diabetes-tconnectsync enrich START END            dry run: prints the plan, changes nothing
    diabetes-tconnectsync enrich START END --apply    delete the old docs, upload the combos

START/END are YYYY-MM-DD (America/Chicago). Credentials come from the wrapper (Keychain).
"""
import hashlib
import json
import logging
import os
import sys
from urllib.parse import quote

import arrow
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import combo_bolus  # noqa: E402
import diabetes_tconnectsync  # noqa: E402


def ns_find_combos(url, secret, start, end):
    """Existing 'Combo Bolus' docs, padded a day each way (extended entries land later)."""
    lo = start.shift(days=-1).to("utc").format("YYYY-MM-DDTHH:mm:ss.SSS") + "Z"
    hi = end.shift(days=1).to("utc").format("YYYY-MM-DDTHH:mm:ss.SSS") + "Z"
    q = "find[eventType]=%s&find[created_at][$gte]=%s&find[created_at][$lte]=%s&count=10000" % (
        quote("Combo Bolus"), quote(lo), quote(hi))
    r = requests.get("%s/api/v1/treatments.json?%s" % (url.rstrip("/"), q),
                     headers={"api-secret": hashlib.sha1(secret.encode()).hexdigest()}, timeout=60)
    r.raise_for_status()
    return r.json()


def main(argv):
    apply = "--apply" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 64
    logging.basicConfig(level=logging.WARNING)
    if not diabetes_tconnectsync.install():
        return 1

    from tconnectsync import secret
    from tconnectsync import features as featmod
    from tconnectsync.api import TConnectApi
    from tconnectsync.nightscout import NightscoutApi
    from tconnectsync.domain.tandemsource.event_class import EventClass
    from tconnectsync.sync.tandemsource.choose_device import ChooseDevice
    from tconnectsync.sync.tandemsource.process_bolus import ProcessBolus

    start = arrow.get(args[0] + "T00:00:00", tzinfo="America/Chicago")
    end = arrow.get(args[1] + "T23:59:59", tzinfo="America/Chicago")
    tconnect = TConnectApi(secret.TCONNECT_EMAIL, secret.TCONNECT_PASSWORD, secret.TCONNECT_REGION)
    ns = NightscoutApi(secret.NS_URL, secret.NS_SECRET)
    device = ChooseDevice(secret, tconnect).choose()

    events = list(tconnect.tandemsource.pump_events(device["assignmentId"], start, end, fetch_all_event_types=False))
    bolus_events = [e for e in events if EventClass.for_event(e) == EventClass.BOLUS]
    idx = combo_bolus.Index(bolus_events)

    pb = ProcessBolus(tconnect, ns, device["assignmentId"], pretend=True, features=[featmod.BOLUS])
    pb.nightscout.last_uploaded_entry = lambda *a, **k: None      # re-emit everything in range
    entries = [e for e in pb.process(bolus_events, start, end) if e.get("splitNow") is not None]

    docs_by_first = {}
    for doc in ns_find_combos(secret.NS_URL, secret.NS_SECRET, start, end):
        first = str(doc.get("pump_event_id") or "").split(",")[0]
        if first.isdigit():
            docs_by_first.setdefault(int(first), []).append(doc)

    # A combo is replaced only when its old plain immediate-dose doc exists; otherwise it is
    # already correct (or was removed on purpose) and is left alone. The redundant
    # extended-completion doc goes with it.
    delete, upload = [], []
    for entry in entries:
        seq = int(str(entry["pump_event_id"]).split(",")[0])
        plain = [d for d in docs_by_first.get(seq, []) if "enteredinsulin" not in d]
        if not plain:
            continue
        bolus_id = idx.completed_by_seq[seq].bolusId
        ext_docs = [d for s, b in idx.bolex_by_seq.items() if b.bolusId == bolus_id
                    for d in docs_by_first.get(s, []) if "," not in str(d.get("pump_event_id"))]
        delete += plain + ext_docs
        upload.append(entry)

    print("combos in range: %d | to replace: %d (delete %d docs, upload %d) | the rest are already correct" % (
        len(entries), len(upload), len(delete), len(upload)))
    for doc in delete:
        print("  DELETE %s %s insulin=%s %s" % (doc.get("_id"), doc.get("created_at"), doc.get("insulin"), doc.get("notes")))
    for e in upload:
        print("  UPLOAD", json.dumps({k: e[k] for k in ("created_at", "insulin", "enteredinsulin", "splitNow", "splitExt", "duration", "relative", "pump_event_id")}))
    if not apply:
        print("dry run: nothing changed (add --apply)")
        return 0
    for doc in delete:
        ns.delete_entry("treatments/%s" % doc["_id"])
    for e in upload:
        ns.upload_entry(e)
    print("applied: deleted %d, uploaded %d" % (len(delete), len(upload)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
