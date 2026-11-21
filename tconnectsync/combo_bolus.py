import logging

logger = logging.getLogger("diabetes.combo_bolus")

COMPLETED = "LID_BOLUS_COMPLETED"
BOLEX = "LID_BOLEX_COMPLETED"
MSG2 = "LID_BOLUS_REQUESTED_MSG2"
MSG3 = "LID_BOLUS_REQUESTED_MSG3"


def _name(event):
    return getattr(event, "NAME", None)


def combo_fields(msg2, msg3):
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
        now = {s for s, e in self.completed_by_seq.items() if e.bolusId in self.combo_by_bolus}
        ext = {s for s, e in self.bolex_by_seq.items() if e.bolusId in self.combo_by_bolus}
        return now, ext


def apply_to_entries(entries, events):
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
