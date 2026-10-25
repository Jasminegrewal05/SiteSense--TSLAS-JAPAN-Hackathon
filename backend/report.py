"""
Phase 3 API: after the visit.

  1. Build findings   one card per warning sign: said | numbers | seen   (match.py, no AI)
  2. Keep / Remove    the analyst decides on every card (a removal needs a reason)
  3. Report           made only from kept cards, plus what could not be checked
  4. Submit           analyst -> manager approves, or sends back with a note
  5. Locked           on approval: fingerprinted, nothing can change

Files (encrypted), under data/visits/VIS-xxxx/report/:
  findings.json   the cards and the analyst's decisions
  report.json     summary, follow-up questions, status, approvals, fingerprint
"""

import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import capture_store as cs
import checklist as checklist_mod
import match
import settings
import storage
from auth import get_current_user, require_analyst, require_manager

router = APIRouter(prefix="/api/visits/{visit_id}", tags=["report"])

VERDICTS = ("differs", "not_shown", "supported", "unchecked")


# ---------- files ----------

def _path(visit_id, name):
    return storage.visit_path(visit_id, "report/" + name)


def _read(visit_id, name, default=None):
    p = _path(visit_id, name)
    if not p.exists():
        return default
    return json.loads(storage.read_encrypted(p).decode("utf-8"))


def _write(visit_id, name, data):
    storage.write_encrypted(_path(visit_id, name), json.dumps(data, ensure_ascii=True).encode("utf-8"))


def _user_name(email):
    u = next((u for u in storage.load_users() if u["email"] == email), None)
    return u["name"] if u else email


# ---------- what the visit produced ----------

def _capture(visit_id):
    """Phase 2 results. Empty when the visit was not recorded, or the recording was deleted."""
    s = cs.load_session(visit_id)
    if not s or s["state"] != "done":
        return {"session": s, "claims": [], "cues": [], "notes": [], "people": [], "places": None,
                "kept_pieces": []}
    return {
        "session": s,
        "claims": cs.read(visit_id, "claims.json", []),
        "cues": cs.read(visit_id, "cues.json", []),
        "notes": cs.read(visit_id, "scene_notes.json", []),
        "people": cs.read(visit_id, "people.json", {"people": []})["people"],
        "places": s.get("places_summary"),
        "kept_pieces": s.get("kept_pieces", []),
    }


def _starts(s):
    """Start time of each 10-second piece, so the player opens a clip at the right second."""
    return {k: c["start_ms"] / 1000.0 for k, c in ((s or {}).get("chunks") or {}).items()}


def _ready(visit_id, visit):
    cl = storage.read_json(storage.visit_path(visit_id, "checklist.json"))
    if not cl or cl["status"] != "locked":
        raise HTTPException(409, "Lock the checklist first.")
    s = cs.load_session(visit_id)
    if s and s["state"] not in ("done", "deleted"):
        raise HTTPException(409, "The recording is still being processed.")
    if s and s["state"] == "done" and not s.get("reviewed_at"):
        raise HTTPException(409, "Finish the Review step first.")
    return cl


def _report(visit_id):
    return _read(visit_id, "report.json") or {"status": "draft", "summary": "", "followups": [], "history": []}


def _editable(visit_id):
    rep = _report(visit_id)
    if rep["status"] == "approved":
        raise HTTPException(409, "The report is approved and locked.")
    return rep


def _back_to_draft(visit, user, rep):
    """An edit after submitting sends the report back to draft, like the checklist."""
    if rep["status"] == "submitted":
        rep["status"] = "draft"
        rep["history"].append({"at": storage.now_iso(), "by": user["email"], "event": "back_to_draft"})
        _set_visit_status(visit, "draft")
        storage.append_audit(visit["visit_id"], user["email"], "report_back_to_draft")


def _set_visit_status(visit, status):
    visit["report_status"] = status
    storage.save_visit(visit)


def _default_followups(cl, cards, capture):
    out = []
    for card in cards:
        if card["verdict"] in ("unchecked", "not_shown"):
            for it in cl["items"]:
                if it.get("signal_id") == card["signal_id"] and it["kind"] == "ask":
                    out.append(it["text"])
                    break
    s = capture["session"] or {}
    for iid in s.get("not_discussed", []):
        it = next((x for x in cl["items"] if x["id"] == iid), None)
        if it:
            out.append(it["text"])
    for pl in (capture["places"] or {}).get("places", []):
        if pl.get("listed") and pl["seconds"] == 0:
            out.append("Please show us the " + pl["name"] + ".")
    seen, clean = set(), []
    for q in out:
        if q.lower() not in seen:
            seen.add(q.lower())
            clean.append(q)
    return clean[:12]


# ---------- 1. build findings ----------

@router.post("/findings/build")
def build_findings(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    cl = _ready(visit_id, visit)
    rep = _editable(visit_id)
    metrics = storage.read_json(storage.visit_path(visit_id, "metrics.json"))
    capture = _capture(visit_id)
    cards = match.build(cl, metrics, checklist_mod.load_rules(), capture)

    old = {c["signal_id"]: c for c in (_read(visit_id, "findings.json") or {}).get("cards", [])}
    for c in cards:
        prev = old.get(c["signal_id"])
        c["decision"] = prev.get("decision") if prev else None
        c["note"] = prev.get("note", "") if prev else ""
    _write(visit_id, "findings.json", {"built_at": storage.now_iso(), "built_by": user["email"], "cards": cards})

    if not rep.get("followups_edited"):
        rep["followups"] = _default_followups(cl, cards, capture)
    _back_to_draft(visit, user, rep)
    _write(visit_id, "report.json", rep)
    if not visit.get("report_status"):
        _set_visit_status(visit, "draft")
    storage.append_audit(visit_id, user["email"], "findings_built",
                         {v: sum(1 for c in cards if c["verdict"] == v) for v in VERDICTS})
    return get_findings(visit_id, user)


@router.get("/findings")
def get_findings(visit_id: str, user=Depends(get_current_user)):
    storage.load_visit_for_user(visit_id, user, read_only=True)
    data = _read(visit_id, "findings.json")
    rep = _report(visit_id)
    s = cs.load_session(visit_id)
    return {
        "built": data is not None,
        "built_at": data["built_at"] if data else None,
        "cards": data["cards"] if data else [],
        "report_status": rep["status"],
        "recording": (s or {}).get("state"),
        "review_finished": bool(s and s.get("reviewed_at")),
        "piece_starts": _starts(s),
    }


class DecisionIn(BaseModel):
    action: str
    note: str = Field("", max_length=500)


@router.post("/findings/{fid}")
def decide(visit_id: str, fid: str, body: DecisionIn, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    rep = _editable(visit_id)
    data = _read(visit_id, "findings.json")
    card = next((c for c in (data or {}).get("cards", []) if c["id"] == fid), None)
    if card is None:
        raise HTTPException(404, "Finding not found")
    if body.action not in ("keep", "remove", "undo"):
        raise HTTPException(400, "Unknown action")
    if body.action == "remove" and len(body.note.strip()) < 3:
        raise HTTPException(400, "Say briefly why you are removing it.")
    card["decision"] = None if body.action == "undo" else "kept" if body.action == "keep" else "removed"
    card["note"] = body.note.strip()
    _write(visit_id, "findings.json", data)
    _back_to_draft(visit, user, rep)
    _write(visit_id, "report.json", rep)
    storage.append_audit(visit_id, user["email"], "finding_" + (card["decision"] or "undone"),
                         {"item": card["signal_id"], "note": card["note"]} if card["note"] else {"item": card["signal_id"]})
    return card


# ---------- 2. the report ----------

def report_view(visit_id, visit):
    cl = checklist_mod.load_checklist(visit)
    data = _read(visit_id, "findings.json") or {"cards": []}
    rep = _report(visit_id)
    capture = _capture(visit_id)
    s = capture["session"] or {}
    cards = data["cards"]
    kept = [c for c in cards if c.get("decision") == "kept"]

    could_not = []
    for sk in cl.get("skipped", []):
        could_not.append({"kind": "numbers", "text": sk["signal"] + ": not checked, the documents did not have "
                          + ", ".join(sk.get("needs", [])) + "."})
    not_asked = len(s.get("not_discussed", []))
    if not_asked:
        could_not.append({"kind": "not_asked", "text": str(not_asked) + " planned question" + ("s were" if not_asked > 1 else " was")
                          + " not asked. They are in the questions for the company."})
    for it in cl["items"]:
        if it["kind"] == "look_for" and it.get("signal_id") and it["priority"] == "high" \
                and it["status"] in ("pending", "not_visible"):
            could_not.append({"kind": "not_seen", "text": "Not seen: " + it["text"]})
    for p in s.get("not_analysed", []):
        could_not.append({"kind": "not_analysed", "text": "A 10-second piece at " + cs.fmt_time(
            s["chunks"][str(p)]["start_ms"] / 1000.0) + " could not be transcribed; its clip was kept."})

    other = [{"text": it["text"], "status": it["status"], "note": it.get("note", ""), "area": it["area"]}
             for it in cl["items"] if not it.get("signal_id") and it["status"] in ("ok", "issue")]

    consent = s.get("consent") or {}
    meters = s.get("meters") or {}
    duration = max((c["end_ms"] for c in s.get("chunks", {}).values()), default=0) / 1000.0
    return {
        "visit": {k: visit.get(k) for k in ("visit_id", "company", "visit_date", "visit_type", "location", "purpose",
                                             "analyst_name", "created_by_name")},
        "status": rep["status"],
        "summary": rep.get("summary", ""),
        "followups": rep.get("followups", []),
        "review_note": rep.get("review_note"),
        "approval_note": rep.get("approval_note"),
        "submitted_at": rep.get("submitted_at"),
        "approved_at": rep.get("approved_at"),
        "approved_by": rep.get("approved_by_name"),
        "fingerprint": rep.get("fingerprint"),
        "built": bool(data.get("built_at")),
        "undecided": sum(1 for c in cards if not c.get("decision")),
        "removed": [{"title": c["title"], "note": c.get("note", "")} for c in cards if c.get("decision") == "removed"],
        "counts": {v: sum(1 for c in kept if c["verdict"] == v) for v in VERDICTS},
        "findings": kept,
        "could_not_check": could_not,
        "nothing_unusual": [n["signal"] for n in cl.get("not_triggered", [])],
        "other_observations": other,
        "places": capture["places"],
        "piece_starts": _starts(s),
        "recording": {
            "state": s.get("state"),
            "consent_at": consent.get("answered_at") if consent.get("status") == "found" else None,
            "consent_confirmed_by_hand": bool(consent.get("confirmed_by")),
            "minutes": round(duration / 60.0, 1),
            "raw_deleted_mb": round(meters.get("raw_deleted_bytes", 0) / 1048576.0, 1),
            "kept_mb": round(meters.get("kept_bytes", 0) / 1048576.0, 1),
            "picture_checks": meters.get("ai_calls", 0),
            "evidence_fingerprint": s.get("fingerprint"),
        },
    }


@router.get("/report")
def get_report(visit_id: str, user=Depends(get_current_user)):
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    return report_view(visit_id, visit)


class ReportIn(BaseModel):
    summary: str = Field("", max_length=2000)
    followups: list[str] = Field(default_factory=list, max_length=20)


@router.put("/report")
def edit_report(visit_id: str, body: ReportIn, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    rep = _editable(visit_id)
    rep["summary"] = body.summary.strip()
    rep["followups"] = [f.strip()[:300] for f in body.followups if f.strip()]
    rep["followups_edited"] = True
    _back_to_draft(visit, user, rep)
    _write(visit_id, "report.json", rep)
    storage.append_audit(visit_id, user["email"], "report_edited")
    return report_view(visit_id, visit)


@router.post("/report/submit")
def submit(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    rep = _editable(visit_id)
    data = _read(visit_id, "findings.json")
    if not data:
        raise HTTPException(409, "Build the findings first.")
    left = sum(1 for c in data["cards"] if not c.get("decision"))
    if left:
        raise HTTPException(409, "Decide on every finding first (" + str(left) + " left).")
    if rep["status"] != "draft":
        raise HTTPException(409, "The report is already submitted.")
    rep.update(status="submitted", submitted_at=storage.now_iso(), submitted_by=user["email"])
    rep.pop("review_note", None)
    rep["history"].append({"at": rep["submitted_at"], "by": user["email"], "event": "submitted"})
    _write(visit_id, "report.json", rep)
    _set_visit_status(visit, "submitted")
    storage.append_audit(visit_id, user["email"], "report_submitted")
    if not settings.get_bool("REQUIRE_APPROVAL", "true"):
        return _approve(visit, user, rep, data)
    return report_view(visit_id, visit)


def _fingerprint(visit_id, rep, data):
    s = cs.load_session(visit_id) or {}
    payload = {"cards": data["cards"], "summary": rep.get("summary", ""), "followups": rep.get("followups", []),
               "approved_by": rep.get("approved_by"), "approved_at": rep.get("approved_at"),
               "evidence": s.get("fingerprint")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _approve(visit, user, rep, data):
    vid = visit["visit_id"]
    rep.update(status="approved", approved_at=storage.now_iso(), approved_by=user["email"],
               approved_by_name=user.get("name") or _user_name(user["email"]))
    rep["fingerprint"] = _fingerprint(vid, rep, data)
    rep["history"].append({"at": rep["approved_at"], "by": user["email"], "event": "approved"})
    _write(vid, "report.json", rep)
    _set_visit_status(visit, "approved")
    storage.append_audit(vid, user["email"], "report_approved", {"fingerprint": rep["fingerprint"]})
    return report_view(vid, visit)


class ReviewIn(BaseModel):
    approve: bool
    note: str = Field("", max_length=500)


@router.post("/report/review")
def review(visit_id: str, body: ReviewIn, user=Depends(get_current_user)):
    require_manager(user)
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    if visit.get("analyst_email") == user["email"]:
        raise HTTPException(403, "You cannot approve your own visit.")
    rep = _report(visit_id)
    if rep["status"] != "submitted":
        raise HTTPException(409, "Only a submitted report can be reviewed.")
    data = _read(visit_id, "findings.json")
    if body.approve:
        rep["approval_note"] = body.note.strip()
        return _approve(visit, user, rep, data)
    if len(body.note.strip()) < 3:
        raise HTTPException(400, "Add a short note saying what to change.")
    rep.update(status="draft", review_note=body.note.strip())
    rep["history"].append({"at": storage.now_iso(), "by": user["email"], "event": "sent_back",
                           "note": body.note.strip()})
    _write(visit_id, "report.json", rep)
    _set_visit_status(visit, "sent_back")
    storage.append_audit(visit_id, user["email"], "report_sent_back", {"note": body.note.strip()})
    return report_view(visit_id, visit)


@router.get("/report/verify")
def verify(visit_id: str, user=Depends(get_current_user)):
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    rep = _report(visit_id)
    if rep["status"] != "approved":
        raise HTTPException(409, "The report is fingerprinted when it is approved.")
    data = _read(visit_id, "findings.json")
    ok = _fingerprint(visit_id, rep, data) == rep["fingerprint"]
    storage.append_audit(visit_id, user["email"], "report_verified", {"ok": ok})
    return {"ok": ok, "fingerprint": rep["fingerprint"], "visit": visit["visit_id"]}
