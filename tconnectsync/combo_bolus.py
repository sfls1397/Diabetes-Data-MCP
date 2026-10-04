"""Combo / extended bolus fields for tconnectsync 3.0.3 -> Nightscout.

Stock tconnectsync uploads a combo bolus as two plain "Combo Bolus" treatments: the
immediate dose when it completes, and (hours later) a separate insulin-only
"Extended Bolus" entry. Nightscout then has no idea the two belong together.

This module post-processes stock ProcessBolus output so a true combo/extended bolus
is one treatment in the Care Portal shape, matching what the VM-era patch wrote:

    insulin        immediate units delivered (Nightscout convention)
    enteredinsulin total units requested (immediate + extended)
    splitNow       immediate %    (Tandem LidBolusRequestedMsg2.standardPercent)
    splitExt       extended %     (100 - splitNow)
    duration       extension length, minutes (Msg2.duration)
    relative       extended rate, units/hour: total * splitExt/100 / (duration/60)

Standard boluses (100% now, or duration 0) are left exactly as stock writes them. When
a bolus is a true combo, its later LidBolexCompleted entry is dropped so insulin is not
counted twice in Nightscout IOB. If the request messages are missing, stock output is
kept unchanged (fail open to the legacy two-entry form, never lose insulin).

Pure Python 3.8+, duck-typed on the event `NAME` class attribute, so it is unit-testable
without tconnectsync installed. See diabetes_tconnectsync.py for the runtime hook.
"""
import logging

logger = logging.getLogger("diabetes.combo_bolus")

COMPLETED = "LID_BOLUS_COMPLETED"
BOLEX = "LID_BOLEX_COMPLETED"
MSG2 = "LID_BOLUS_REQUESTED_MSG2"
MSG3 = "LID_BOLUS_REQUESTED_MSG3"


def _name(event):
    return getattr(event, "NAME", None)


def combo_fields(msg2, msg3):
    """Nightscout combo fields for a true combo/extended bolus, else None."""
    if msg2 is None or msg3 is None:
        return None
    pct = getattr(msg2, "standardPercent", None)
    duration = getattr(msg2, "duration", None)
    total = getattr(msg3, "totalBolusSize", None)
    if pct is None or duration is None or total is None:
        return None
    if duration <= 0 or pct >= 100 or pct < 0 or total <= 0:
        return None
    split_ext = 100 - pct
    return {
        "enteredinsulin": round(float(total), 2),
        "splitNow": int(pct),
        "splitExt": int(split_ext),
        "duration": int(duration),
        "relative": round(float(total) * split_ext / 100.0 / (duration / 60.0), 2),
    }


class Index:
    """Lookup tables over one batch of bolus events."""

    def __init__(self, events):
        self.completed_by_seq = {}
        self.bolex_by_seq = {}
        msg2, msg3 = {}, {}
        for e in events:
            n = _name(e)
            if n == COMPLETED:
                self.completed_by_seq[e.seqNum] = e
            elif n == BOLEX:
                self.bolex_by_seq[e.seqNum] = e
            elif n == MSG2:
                msg2[e.bolusId] = e
            elif n == MSG3:
                msg3[e.bolusId] = e
        self.combo_by_bolus = {}
        for bolus_id in set(msg2) & set(msg3):
            fields = combo_fields(msg2[bolus_id], msg3[bolus_id])
            if fields:
                self.combo_by_bolus[bolus_id] = fields

    def replaced_seqs(self):
        """Pump sequence numbers of the stock entries a combo replaces:
        (immediate-dose seqs, extended-completion seqs)."""
        now = {s for s, e in self.completed_by_seq.items() if e.bolusId in self.combo_by_bolus}
        ext = {s for s, e in self.bolex_by_seq.items() if e.bolusId in self.combo_by_bolus}
        return now, ext


def apply_to_entries(entries, events):
    """Return stock Nightscout entries with combo fields merged in and the redundant
    extended-completion entries removed. `entries` is ProcessBolus.process output;
    `events` is the same event batch it was given."""
    idx = Index(events)
    if not idx.combo_by_bolus:
        return list(entries)
    out = []
    for entry in entries:
        if entry.get("eventType") == "Combo Bolus":
            pump_id = str(entry.get("pump_event_id") or "")
            first = pump_id.split(",")[0]
            seq = int(first) if first.isdigit() else None
            done = idx.completed_by_seq.get(seq)
            if done is not None and done.bolusId in idx.combo_by_bolus:
                entry = dict(entry)
                entry.update(idx.combo_by_bolus[done.bolusId])
                logger.info("combo bolus %s: %s", done.bolusId, idx.combo_by_bolus[done.bolusId])
            else:
                bolex = idx.bolex_by_seq.get(seq)
                if bolex is not None and "," not in pump_id and bolex.bolusId in idx.combo_by_bolus:
                    logger.info("combo bolus %s: dropping extended-completion entry (counted in the combo)", bolex.bolusId)
                    continue
        out.append(entry)
    return out
