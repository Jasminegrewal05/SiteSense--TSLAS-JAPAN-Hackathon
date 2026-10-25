"""
Files for one visit's recording, under data/visits/<id>/capture/

  session.json          state, timing, pieces received, marks, privacy pauses, meters
  raw/                  incoming 10-second pieces, ENCRYPTED, deleted within seconds
  pending/              blurred clips, ENCRYPTED, kept only if linked to evidence
  clips/                kept blurred clips, ENCRYPTED
  analysis/             per-piece working data, ENCRYPTED, deleted after the visit
  transcript_live.json  first-pass transcript shown during the visit       ENCRYPTED
  scene_notes.json      picture checks                                       ENCRYPTED
  transcript.json, people.json, claims.json, cues.json, suggestions.json    ENCRYPTED
  manifest.json         fingerprints of the evidence, written when the review is finished
  deletion_log.jsonl    proof of every deletion

Result files hold what the company said, so they are encrypted like the clips.
Older plain files (from before this change) can still be read.

Legal hold: while a visit is on hold, kept evidence (clips and result files) cannot be
deleted by anything. Unblurred video is still deleted, because privacy comes first.
"""

import json
import shutil
import threading

from fastapi import HTTPException

import storage

_locks = {}
_guard = threading.Lock()


def lock_for(visit_id):
    with _guard:
        return _locks.setdefault(visit_id, threading.RLock())


def cap_dir(visit_id):
    return storage.visit_dir(visit_id) / "capture"


def path(visit_id, name):
    return cap_dir(visit_id) / name


def load_session(visit_id):
    return storage.read_json(path(visit_id, "session.json"))


def save_session(visit_id, session):
    storage.write_json(path(visit_id, "session.json"), session)


def update_session(visit_id, fn):
    """Read, change and save session.json safely (the worker and the API both write it)."""
    with lock_for(visit_id):
        session = load_session(visit_id)
        result = fn(session)
        save_session(visit_id, session)
        return result


def read(visit_id, name, default=None):
    """Result files are encrypted. A plain file from an older version is still read."""
    p = path(visit_id, name)
    if not p.exists():
        return default
    raw = p.read_bytes()
    if raw[:1] in (b"{", b"["):
        return json.loads(raw.decode("utf-8"))
    return json.loads(storage.read_encrypted(p).decode("utf-8"))


def write(visit_id, name, data):
    storage.write_encrypted(path(visit_id, name), json.dumps(data, ensure_ascii=True).encode("utf-8"))


def read_secret_json(visit_id, name):
    p = path(visit_id, name)
    if not p.exists():
        return None
    return json.loads(storage.read_encrypted(p).decode("utf-8"))


def write_secret_json(visit_id, name, data):
    storage.write_encrypted(path(visit_id, name), json.dumps(data).encode("utf-8"))


def append_line(visit_id, name, entry):
    p = path(visit_id, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=True) + "\n")


# Evidence that a legal hold protects. Unblurred pieces (raw/), temporary folders and
# working data (analysis/) are NOT protected: they must always be deleted.
EVIDENCE_FILES = {"transcript.json", "transcript_live.json", "people.json", "claims.json", "cues.json",
                  "suggestions.json", "scene_notes.json", "manifest.json"}


def on_legal_hold(visit_id):
    visit = storage.read_json(storage.visit_path(visit_id, "visit.json")) or {}
    return bool(visit.get("legal_hold"))


def _is_evidence(file_path):
    return file_path.parent.name == "clips" or file_path.name in EVIDENCE_FILES


def delete_file(visit_id, file_path, what):
    """Deletes a file and records it in deletion_log.jsonl. Returns bytes freed."""
    if _is_evidence(file_path) and file_path.exists() and on_legal_hold(visit_id):
        raise HTTPException(423, "This visit is on legal hold, so its evidence cannot be deleted.")
    size = file_path.stat().st_size if file_path.exists() else 0
    file_path.unlink(missing_ok=True)
    append_line(visit_id, "deletion_log.jsonl", {
        "time": storage.now_iso(), "what": what, "file": file_path.name, "bytes": size,
    })
    return size


def delete_dir(visit_id, dir_path, what):
    """Deletes a temporary folder and logs it, with the files and bytes it held."""
    if not dir_path.exists():
        return 0
    files = [f for f in dir_path.rglob("*") if f.is_file()]
    size = sum(f.stat().st_size for f in files)
    shutil.rmtree(dir_path, ignore_errors=True)
    append_line(visit_id, "deletion_log.jsonl", {
        "time": storage.now_iso(), "what": what, "file": dir_path.name + "/", "files": len(files), "bytes": size,
    })
    return size


def fmt_time(seconds):
    seconds = int(max(0, seconds))
    return str(seconds // 60) + ":" + str(seconds % 60).zfill(2)
