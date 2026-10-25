"""
Phase 2 API: recording during the visit, live status, and the review afterwards.

The phone sends one 10-second piece at a time. During the visit the analyst only
starts, ends, and optionally taps Mark or Privacy pause. Everything else is worked
out on the laptop and confirmed by the analyst in the review.
"""

import hashlib
import json
import re
import shutil
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import capture_store as cs
import checklist as checklist_mod
import media
import pipeline
import settings
import storage
import stt
import vision
import voice
from auth import get_current_user

router = APIRouter(prefix="/api/visits/{visit_id}/capture", tags=["capture"])

VIDEO_EXT = {".webm", ".mp4", ".mov", ".m4v", ".mkv", ".3gp"}
MAX_PIECE_MB = 60
MAX_REPLAY_MB = 1500


def _visit(visit_id, user, read_only=False):
    """The assigned analyst (after accepting) can record and review. A manager can only look."""
    visit = storage.load_visit_for_user(visit_id, user, read_only=read_only)
    cl = storage.read_json(storage.visit_path(visit_id, "checklist.json"))
    if not cl or cl["status"] != "locked":
        raise HTTPException(409, "Lock the checklist before recording the visit.")
    return visit, cl


def _new_session(user, replay):
    return {
        "state": "recording",
        "replay": replay,
        "started_at": storage.now_iso(),
        "ended_at": None,
        "analyst_email": user["email"],
        "analyst_name": user["name"],
        "chunks": {},
        "marks": [],
        "pauses": [],
        "meters": {"raw_deleted_bytes": 0, "pending_bytes": 0, "kept_bytes": 0, "ai_calls": 0, "ai_errors": 0},
    }


def _blockers():
    """What must work before a visit may start. Recording without these would lose evidence."""
    out = []
    if not media.ffmpeg_ok():
        out.append("ffmpeg is not installed, so video cannot be blurred.")
    if not media.finder().ok:
        out.append("The face finder is missing, so faces cannot be blurred.")
    if settings.get_bool("REQUIRE_SPEECH", "true"):
        st = stt.status()
        if st == "loading":
            out.append("The speech model is still loading. Try again in a few seconds.")
        elif st != "ready":
            out.append("Speech to text is not ready (" + st + "). Run: python prepare_speech.py")
    return out


def _require_ready():
    blockers = _blockers()
    if blockers:
        raise HTTPException(409, "This laptop is not ready to record: " + " ".join(blockers))


def _system():
    return {
        "ffmpeg": media.ffmpeg_ok(),
        "faces": media.finder().kind or "missing",
        "speech": stt.status(),
        "voice_matching": voice.available(),
        "picture_check": vision.configured(),
        "ai_budget": pipeline.ai_budget(),
        "blockers": _blockers(),
    }


def _live_not_discussed(cl, lines):
    keywords = {it["id"]: [k.lower() for k in (it.get("topics") or [])] for it in cl["items"]}
    said = " ".join(l["text"].lower() for l in lines)
    out = []
    for it in cl["items"]:
        if it["kind"] == "ask" and it["priority"] == "high" and keywords[it["id"]]:
            if not any(re.search(r"\b" + re.escape(k) + r"\b", said) for k in keywords[it["id"]]):
                out.append({"id": it["id"], "text": it["text"], "signal": it.get("why") or ""})
    return out


def _live_not_shown(cl, s, notes):
    """Places on the list with no 'Now in' tap and no picture of them yet."""
    seen = {p["place"].lower() for p in s.get("places", [])} | {n.get("area", "").lower() for n in notes}
    return [p["name"] for p in (cl.get("places") or []) if p["name"].lower() not in seen]


# ---------- status ----------

@router.get("")
def status(visit_id: str, user=Depends(get_current_user)):
    visit, cl = _visit(visit_id, user, read_only=True)
    s = cs.load_session(visit_id)
    lines = cs.read(visit_id, "transcript_live.json", [])
    out = {"system": _system(), "session": None, "live": None}
    if s:
        chunks = [dict(c, index=int(k)) for k, c in sorted(s["chunks"].items(), key=lambda kv: int(kv[0]))]
        out["session"] = {k: s.get(k) for k in ("state", "replay", "started_at", "ended_at", "marks", "pauses",
                                                 "meters", "consent", "not_discussed", "error", "reviewed_at",
                                                 "finalized_at", "kept_pieces", "not_analysed", "lost_pieces",
                                                 "asking", "places")}
        out["session"]["chunks"] = chunks
        out["live"] = {
            "transcript": lines[-80:],
            "notes": cs.read(visit_id, "scene_notes.json", [])[-30:],
            "not_discussed": _live_not_discussed(cl, lines),
            "not_shown": _live_not_shown(cl, s, cs.read(visit_id, "scene_notes.json", [])),
        }
    return out


@router.post("/pair-code")
def pair_code(visit_id: str, user=Depends(get_current_user)):
    """A one-time code for the QR: the phone that scans it can record this visit, with no password."""
    from auth import PAIR_MINUTES, make_pair_code, require_analyst
    require_analyst(user)
    if user.get("device_visit"):
        raise HTTPException(403, "A paired phone cannot pair another device.")
    _visit(visit_id, user)
    return {"code": make_pair_code(user, visit_id), "minutes": PAIR_MINUTES}


# ---------- recording ----------

@router.post("/start")
def start(visit_id: str, user=Depends(get_current_user)):
    _visit(visit_id, user)
    with cs.lock_for(visit_id):
        s = cs.load_session(visit_id)
        if s and s["state"] in ("recording", "paused"):
            return {"ok": True, "resumed": True}
        if s:
            raise HTTPException(409, "This visit has already been recorded.")
        _require_ready()
        cs.cap_dir(visit_id).mkdir(parents=True, exist_ok=True)
        cs.save_session(visit_id, _new_session(user, replay=False))
    storage.append_audit(visit_id, user["email"], "recording_started")
    return {"ok": True, "resumed": False}


@router.post("/chunks")
async def upload_piece(
    visit_id: str,
    file: UploadFile = File(...),
    index: int = Form(...),
    start_ms: int = Form(...),
    end_ms: int = Form(...),
    user=Depends(get_current_user),
):
    _visit(visit_id, user)
    content = await file.read(MAX_PIECE_MB * 1024 * 1024 + 1)
    if len(content) > MAX_PIECE_MB * 1024 * 1024:
        raise HTTPException(413, "Piece too large.")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        ext = ".mp4" if "mp4" in (file.content_type or "") else ".webm"
    if index < 0 or end_ms <= start_ms:
        raise HTTPException(400, "Bad piece timing.")

    def add(s):
        if s is None or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        if str(index) in s["chunks"]:
            return False  # already received (the phone retried)
        name = "piece_" + str(index).zfill(4) + ".enc"
        storage.write_encrypted(cs.path(visit_id, "raw/" + name), content)
        s["chunks"][str(index)] = {
            "start_ms": start_ms, "end_ms": end_ms, "ext": ext, "file": name, "size_raw": len(content),
            "received_at": storage.now_iso(), "status": "queued", "steps": {"received": "done"},
        }
        return True

    with cs.lock_for(visit_id):
        s = cs.load_session(visit_id)
        is_new = add(s)
        cs.save_session(visit_id, s)
    if is_new:
        pipeline.enqueue_chunk(visit_id, index)
    return {"ok": True, "new": is_new}


class MarkIn(BaseModel):
    t: float = Field(ge=0)


@router.post("/mark")
def mark(visit_id: str, body: MarkIn, user=Depends(get_current_user)):
    _visit(visit_id, user)

    def add(s):
        if not s or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        s["marks"].append({"t": round(body.t, 2), "at": storage.now_iso()})
        return len(s["marks"])
    count = cs.update_session(visit_id, add)
    return {"ok": True, "marks": count}


class AskingIn(BaseModel):
    t: float = Field(ge=0)
    name: str = Field(min_length=1, max_length=80)


@router.post("/asking")
def asking(visit_id: str, body: AskingIn, user=Depends(get_current_user)):
    """'Asking now': who the analyst is asking. The next other voice gets this name."""
    _visit(visit_id, user)

    def add(s):
        if not s or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        s.setdefault("asking", []).append({"t": round(body.t, 2), "name": body.name.strip()})
    cs.update_session(visit_id, add)
    return {"ok": True}


class PlaceIn(BaseModel):
    t: float = Field(ge=0)
    place: str = Field(min_length=1, max_length=80)


@router.post("/place")
def place(visit_id: str, body: PlaceIn, user=Depends(get_current_user)):
    """'Now in': the place the analyst has just walked into."""
    _visit(visit_id, user)

    def add(s):
        if not s or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        s.setdefault("places", []).append({"t": round(body.t, 2), "place": body.place.strip()})
    cs.update_session(visit_id, add)
    return {"ok": True}


class PauseIn(BaseModel):
    paused: bool
    t: float = Field(ge=0)


@router.post("/pause")
def pause(visit_id: str, body: PauseIn, user=Depends(get_current_user)):
    _visit(visit_id, user)

    def apply(s):
        if not s or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        if body.paused and s["state"] == "recording":
            s["pauses"].append({"start": round(body.t, 2), "end": None})
            s["state"] = "paused"
        elif not body.paused and s["state"] == "paused":
            s["pauses"][-1]["end"] = round(body.t, 2)
            s["state"] = "recording"
    cs.update_session(visit_id, apply)
    storage.append_audit(visit_id, user["email"], "privacy_pause_on" if body.paused else "privacy_pause_off")
    return {"ok": True}


@router.post("/end")
def end(visit_id: str, user=Depends(get_current_user)):
    _visit(visit_id, user)

    def apply(s):
        if not s or s["state"] not in ("recording", "paused"):
            raise HTTPException(409, "The visit is not recording.")
        if s["state"] == "paused" and s["pauses"]:
            s["pauses"][-1]["end"] = s["pauses"][-1]["start"]
        s["state"] = "ending"
        s["ended_at"] = storage.now_iso()
    cs.update_session(visit_id, apply)
    pipeline.enqueue_finalize(visit_id)
    storage.append_audit(visit_id, user["email"], "recording_ended")
    return {"ok": True}


# ---------- replay mode: process an already-recorded video ----------

@router.post("/replay")
async def replay(visit_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    _visit(visit_id, user)
    ext = Path(file.filename or "video.mp4").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, "Upload a video file (mp4, mov or webm).")
    _require_ready()
    with cs.lock_for(visit_id):
        if cs.load_session(visit_id):
            raise HTTPException(409, "This visit has already been recorded.")
        cs.cap_dir(visit_id).mkdir(parents=True, exist_ok=True)
        s = _new_session(user, replay=True)
        s["state"] = "splitting"
        cs.save_session(visit_id, s)

    work = Path(tempfile.mkdtemp(prefix="ss_replay_", dir=cs.cap_dir(visit_id)))
    src = work / ("upload" + ext)
    size = 0
    with open(src, "wb") as f:
        while True:
            block = await file.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > MAX_REPLAY_MB * 1024 * 1024:
                shutil.rmtree(work, ignore_errors=True)
                cs.path(visit_id, "session.json").unlink(missing_ok=True)
                raise HTTPException(413, "Video is larger than " + str(MAX_REPLAY_MB) + " MB.")
            f.write(block)
    storage.append_audit(visit_id, user["email"], "replay_uploaded", {"file": file.filename, "bytes": size})
    threading.Thread(target=_split_replay, args=(visit_id, src, work), daemon=True).start()
    return {"ok": True}


def _split_replay(visit_id, src, work):
    try:
        pieces = media.split_video(src, work / "pieces", seconds=10)
        start = 0.0
        for i, piece in enumerate(pieces):
            dur = media.probe(piece)["duration"] or 10.0
            name = "piece_" + str(i).zfill(4) + ".enc"
            storage.write_encrypted(cs.path(visit_id, "raw/" + name), piece.read_bytes())

            def add(s, i=i, start=start, dur=dur, name=name, size=piece.stat().st_size):
                s["chunks"][str(i)] = {
                    "start_ms": int(start * 1000), "end_ms": int((start + dur) * 1000), "ext": ".mp4",
                    "file": name, "size_raw": size, "received_at": storage.now_iso(),
                    "status": "queued", "steps": {"received": "done"},
                }
            cs.update_session(visit_id, add)
            pipeline.enqueue_chunk(visit_id, i)
            start += dur
        cs.update_session(visit_id, lambda s: s.update(state="ending", ended_at=storage.now_iso()))
        pipeline.enqueue_finalize(visit_id)
    except Exception as e:
        message = "Could not read the video: " + str(e)[:160]
        cs.update_session(visit_id, lambda s, message=message: s.update(state="failed", error=message))
    finally:
        cs.delete_file(visit_id, src, "uploaded original video")
        cs.delete_dir(visit_id, work, "temporary folder for the uploaded video")


# ---------- clips ----------

@router.get("/clips/{piece}")
def clip(visit_id: str, piece: int, request: Request, user=Depends(get_current_user)):
    storage.load_visit_for_user(visit_id, user, read_only=True)
    name = pipeline._clip_name(piece)
    p = cs.path(visit_id, "clips/" + name)
    if not p.exists():
        p = cs.path(visit_id, "pending/" + name)
    if not p.exists():
        raise HTTPException(404, "This clip was not kept.")
    data = storage.read_encrypted(p)
    total = len(data)
    rng = request.headers.get("range")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            a = int(m.group(1)) if m.group(1) else 0
            b = int(m.group(2)) if m.group(2) else total - 1
            b = min(b, total - 1)
            if a <= b:
                headers["Content-Range"] = "bytes " + str(a) + "-" + str(b) + "/" + str(total)
                return Response(data[a:b + 1], status_code=206, media_type="video/mp4", headers=headers)
    return Response(data, media_type="video/mp4", headers=headers)


# ---------- review ----------

def _done_session(visit_id):
    s = cs.load_session(visit_id)
    if not s or s["state"] not in ("done", "deleted"):
        raise HTTPException(409, "The visit is still being processed.")
    return s


def _open_review(visit_id):
    """Like _done_session, but refuses changes once the review is finished and fingerprinted."""
    s = _done_session(visit_id)
    if s.get("reviewed_at"):
        raise HTTPException(409, "The review is finished and locked, so it can no longer be changed.")
    return s


@router.get("/review")
def review(visit_id: str, user=Depends(get_current_user)):
    visit, cl = _visit(visit_id, user, read_only=True)
    s = _done_session(visit_id)
    items = {it["id"]: {k: it[k] for k in ("id", "area", "kind", "text", "priority", "status", "marked_by", "note")}
             for it in cl["items"]}
    return {
        "state": s["state"],
        "consent": s.get("consent"),
        "reviewed_at": s.get("reviewed_at"),
        "meters": s["meters"],
        "kept_pieces": s.get("kept_pieces", []),
        "pieces": {k: {"start": c["start_ms"] / 1000.0, "end": c["end_ms"] / 1000.0} for k, c in s["chunks"].items()},
        "transcript": cs.read(visit_id, "transcript.json", {"lines": []}),
        "people": cs.read(visit_id, "people.json", {"people": []})["people"],
        "claims": cs.read(visit_id, "claims.json", []),
        "cues": cs.read(visit_id, "cues.json", []),
        "suggestions": cs.read(visit_id, "suggestions.json", []),
        "not_discussed": s.get("not_discussed", []),
        "not_analysed": s.get("not_analysed", []),
        "lost_pieces": s.get("lost_pieces", []),
        "fingerprint": s.get("fingerprint"),
        "places": s.get("places_summary") or {"places": []},
        "asking": s.get("asking", []),
        "analyst_name": s.get("analyst_name", ""),
        "legal_hold": bool(visit.get("legal_hold")),
        "items": items,
        "visit_people": visit.get("people", []),
    }


class NamesIn(BaseModel):
    names: dict[str, str]


@router.put("/review/people")
def name_people(visit_id: str, body: NamesIn, user=Depends(get_current_user)):
    _visit(visit_id, user)
    _open_review(visit_id)
    data = cs.read(visit_id, "people.json", {"people": []})
    for p in data["people"]:
        if p["id"] in body.names:
            p["name"] = body.names[p["id"]].strip()[:80]
    cs.write(visit_id, "people.json", data)
    storage.append_audit(visit_id, user["email"], "speakers_named")
    return data


class LineFixIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@router.put("/review/lines/{line_id}")
def fix_line(visit_id: str, line_id: str, body: LineFixIn, user=Depends(get_current_user)):
    """The analyst corrects words the speech model got wrong. The original is kept and the change is logged.
    If the line is a company statement, its claim is updated too (or added / removed by its new topics)."""
    import analysis
    _, cl = _visit(visit_id, user)
    _open_review(visit_id)
    data = cs.read(visit_id, "transcript.json", {"lines": []})
    line = next((l for l in data["lines"] if l["id"] == line_id), None)
    if line is None:
        raise HTTPException(404, "Line not found")
    new = body.text.strip()
    if new == line["text"]:
        return line
    line.setdefault("original", line["text"])
    line["text"] = new
    line["corrected_by"] = user["email"]
    line["unclear"] = False
    keywords = {it["id"]: [k.lower() for k in (it.get("topics") or [])] for it in cl["items"]}
    line["topics"] = analysis.topics_of(new, keywords, analysis._weak_topics())
    cs.write(visit_id, "transcript.json", data)

    claims = cs.read(visit_id, "claims.json", [])
    claim = next((c for c in claims if c["line"] == line_id), None)
    company = line["speaker"] not in (None, "analyst") and line["sure"] != "unsure"
    if claim and (not company or not line["topics"]):
        claims = [c for c in claims if c["line"] != line_id]
    elif claim:
        claim.update(text=new, items=line["topics"], unclear=False, corrected=True)
    elif company and line["topics"]:
        claims.append({"id": "C" + str(len(claims) + 1).zfill(3) + "x", "line": line_id, "time": line["time"],
                       "text": new, "speaker": line["speaker"], "sure": line["sure"], "items": line["topics"],
                       "piece": line["piece"], "end_piece": line.get("end_piece", line["piece"]),
                       "unclear": False, "corrected": True})
        claims.sort(key=lambda c: c["time"])
    cs.write(visit_id, "claims.json", claims)
    storage.append_audit(visit_id, user["email"], "line_corrected",
                         {"line": line_id, "old": line["original"], "new": new})
    return line


class ConsentIn(BaseModel):
    action: str


@router.post("/review/consent")
def consent_decision(visit_id: str, body: ConsentIn, user=Depends(get_current_user)):
    _visit(visit_id, user)
    s = _open_review(visit_id)
    if body.action == "delete_all" and cs.on_legal_hold(visit_id):
        raise HTTPException(423, "This visit is on legal hold, so its recording cannot be deleted.")
    if body.action == "confirm":
        cs.update_session(visit_id, lambda s: s["consent"].update(
            confirmed_by=user["email"], confirmed_at=storage.now_iso()))
        storage.append_audit(visit_id, user["email"], "consent_confirmed")
    elif body.action == "delete_all":
        for folder in ("clips", "pending"):
            d = cs.path(visit_id, folder)
            if d.exists():
                for f in d.iterdir():
                    cs.delete_file(visit_id, f, "deleted by analyst: no consent")
        for name in ("transcript.json", "transcript_live.json", "people.json", "claims.json", "cues.json",
                     "suggestions.json", "scene_notes.json"):
            cs.delete_file(visit_id, cs.path(visit_id, name), "deleted by analyst: no consent")

        def wipe(s):
            s["state"] = "deleted"
            s["meters"]["kept_bytes"] = 0
            s["kept_pieces"] = []
        cs.update_session(visit_id, wipe)
        storage.append_audit(visit_id, user["email"], "recording_deleted_no_consent")
    else:
        raise HTTPException(400, "Unknown action")
    return {"ok": True, "had": s.get("consent")}


class DecisionIn(BaseModel):
    action: str


@router.post("/review/suggestions/{sid}")
def decide(visit_id: str, sid: str, body: DecisionIn, user=Depends(get_current_user)):
    visit, _ = _visit(visit_id, user)
    _open_review(visit_id)
    suggestions = cs.read(visit_id, "suggestions.json", [])
    sg = next((x for x in suggestions if x["id"] == sid), None)
    if not sg:
        raise HTTPException(404, "Suggestion not found")
    if body.action == "accept":
        checklist_mod.mark_item(visit, user, sg["item"], sg["status"], sg["text"], source="suggestion")
        sg["decision"] = "accepted"
    elif body.action == "dismiss":
        sg["decision"] = "dismissed"
    else:
        raise HTTPException(400, "Unknown action")
    sg["decided_at"] = storage.now_iso()
    cs.write(visit_id, "suggestions.json", suggestions)
    storage.append_audit(visit_id, user["email"], "suggestion_" + sg["decision"], {"item": sg["item"], "id": sid})
    return sg


MANIFEST_FILES = ("transcript.json", "people.json", "claims.json", "cues.json", "suggestions.json",
                  "scene_notes.json")


def _manifest(visit_id):
    """SHA-256 of every kept clip and result file, and of the checklist with its ticks."""
    files = {}
    for name in MANIFEST_FILES:
        p = cs.path(visit_id, name)
        if p.exists():
            files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
    clips = cs.path(visit_id, "clips")
    if clips.exists():
        for f in sorted(clips.iterdir()):
            files["clips/" + f.name] = hashlib.sha256(f.read_bytes()).hexdigest()
    return files


def _fingerprint(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest()


@router.post("/review/finish")
def finish(visit_id: str, user=Depends(get_current_user)):
    visit, _ = _visit(visit_id, user)
    s = _done_session(visit_id)
    if s.get("reviewed_at"):
        raise HTTPException(409, "The review is already finished.")
    consent = s.get("consent") or {}
    if s["state"] == "done" and consent.get("status") != "found" and not consent.get("confirmed_by"):
        raise HTTPException(409, "Confirm consent, or delete the recording, before finishing.")
    files = _manifest(visit_id)
    fp = _fingerprint(files)
    finished_at = storage.now_iso()
    cs.write(visit_id, "manifest.json", {"created_at": finished_at, "by": user["email"],
                                         "files": files, "fingerprint": fp})
    cs.update_session(visit_id, lambda s: s.update(reviewed_at=finished_at, fingerprint=fp))
    storage.append_audit(visit_id, user["email"], "review_finished", {"fingerprint": fp})
    storage.refresh_index(visit)
    return {"ok": True, "fingerprint": fp}


@router.get("/review/verify")
def verify(visit_id: str, user=Depends(get_current_user)):
    """Recomputes the fingerprints and lists anything changed since the review was finished."""
    _visit(visit_id, user, read_only=True)
    manifest = cs.read(visit_id, "manifest.json")
    if not manifest:
        raise HTTPException(409, "Finish the review first: that is when the evidence is fingerprinted.")
    now = _manifest(visit_id)
    then = manifest["files"]
    changed = sorted(k for k in then if now.get(k) != then[k])
    added = sorted(k for k in now if k not in then)
    storage.append_audit(visit_id, user["email"], "evidence_verified", {"ok": not changed and not added})
    return {"ok": not changed and not added, "fingerprint": manifest["fingerprint"],
            "checked_files": len(then), "changed": changed, "added": added,
            "finished_at": manifest["created_at"]}
