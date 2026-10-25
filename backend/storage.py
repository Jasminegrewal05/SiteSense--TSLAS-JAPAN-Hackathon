"""
All file reading and writing for SiteSense lives here.

Layout on disk:
    data/
      users.json               local accounts (hashed passwords)
      auth_log.jsonl           login / logout history
      visits_index.json        one summary line per visit (for the home page)
      visits/
        VIS-0001/
          visit.json           form details + list of documents
          docs/DOC-xxxx.enc    uploaded files, encrypted
          metrics_raw.json     numbers read from the documents
          metrics.json         numbers confirmed by the analyst + ratios
          checklist.json       risk signals + checklist items + marks
          audit_log.jsonl      every action, one JSON line each
"""

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from fastapi import HTTPException

import settings

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
VISITS_DIR = DATA_DIR / "visits"
INDEX_FILE = DATA_DIR / "visits_index.json"
USERS_FILE = DATA_DIR / "users.json"
CONFIG_DIR = BASE_DIR / "config"
DEMO_DIR = BASE_DIR / "demo_data"

VISIT_ID_RE = re.compile(r"^VIS-\d{4}$")
DOC_ID_RE = re.compile(r"^DOC-[0-9a-f]{8}$")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------- JSON helpers ----------

def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    # Write to a temp file, then rename, so a crash never leaves half a file.
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=True)
    os.replace(tmp_path, path)


def ensure_dirs():
    VISITS_DIR.mkdir(parents=True, exist_ok=True)
    if not INDEX_FILE.exists():
        write_json(INDEX_FILE, {"next_number": 1, "visits": []})
    if not USERS_FILE.exists():
        write_json(USERS_FILE, {"users": []})


# ---------- Encrypted files ----------

def _fernet():
    """Newest key encrypts. The newest key and any OLD keys can all decrypt.
    That is what lets keys be rotated without losing old files."""
    key = settings.get("FILE_ENCRYPTION_KEY")
    if not key:
        raise HTTPException(500, "FILE_ENCRYPTION_KEY is not set in backend/.env. Run setup_env.py.")
    old_keys = [k.strip() for k in settings.get("FILE_ENCRYPTION_KEYS_OLD").split(",") if k.strip()]
    try:
        return MultiFernet([Fernet(k.encode()) for k in [key] + old_keys])
    except ValueError:
        raise HTTPException(500, "A key in backend/.env is not a valid encryption key.")


def reencrypt_file(path):
    """Re-write one encrypted file with the newest key. Returns True if it changed."""
    path = Path(path)
    token = path.read_bytes()
    try:  # already on the newest key? then leave it alone
        Fernet(settings.get("FILE_ENCRYPTION_KEY").encode()).decrypt(token)
        return False
    except InvalidToken:
        pass
    new_token = _fernet().rotate(token)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(new_token)
    os.replace(tmp, path)
    return True


def write_encrypted(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(_fernet().encrypt(data))


def read_encrypted(path):
    with open(path, "rb") as f:
        token = f.read()
    try:
        return _fernet().decrypt(token)
    except InvalidToken:
        raise HTTPException(
            500, "A stored file could not be decrypted. Was FILE_ENCRYPTION_KEY changed?"
        )


# ---------- Access config ----------

def load_access():
    cfg = read_json(CONFIG_DIR / "access.json", {})
    return {
        "domains": [d.lower().strip() for d in cfg.get("allowed_domains", [])],
        "emails": [e.lower().strip() for e in cfg.get("allowed_emails", [])],
        "managers": [e.lower().strip() for e in cfg.get("managers", [])],
    }


def load_users():
    return read_json(USERS_FILE, {"users": []})["users"]


def save_users(users):
    write_json(USERS_FILE, {"users": users})


# ---------- Visits ----------

def visit_dir(visit_id):
    if not VISIT_ID_RE.match(visit_id or ""):
        raise HTTPException(404, "Visit not found")
    return VISITS_DIR / visit_id


def visit_path(visit_id, name):
    return visit_dir(visit_id) / name


def new_visit_id():
    index = read_json(INDEX_FILE, {"next_number": 1, "visits": []})
    number = index.get("next_number", 1)
    index["next_number"] = number + 1
    write_json(INDEX_FILE, index)
    return "VIS-" + str(number).zfill(4)


def load_visit(visit_id):
    visit = read_json(visit_path(visit_id, "visit.json"))
    if visit is None:
        raise HTTPException(404, "Visit not found")
    return visit


def load_visit_for_user(visit_id, user, read_only=False, allow_unaccepted=False):
    """Analysts reach only their own visits. Managers can VIEW any visit (read_only=True)
    but cannot change anything on someone else's visit."""
    visit = load_visit(visit_id)
    if visit.get("analyst_email") and visit.get("analyst_email") == user["email"]:
        # The assigned analyst can look right away, but can work only after accepting.
        if not read_only and not allow_unaccepted and visit.get("assignment", "accepted") != "accepted":
            raise HTTPException(409, "Accept this visit first. You cannot work on it until you do.")
        return visit
    if user.get("role") == "manager" and read_only:
        return visit
    # Someone else's visit looks exactly like a missing one.
    raise HTTPException(404, "Visit not found")


def save_visit(visit):
    visit["updated_at"] = now_iso()
    write_json(visit_path(visit["visit_id"], "visit.json"), visit)
    refresh_index(visit)


def coverage(items):
    counts = {"total": len(items), "ok": 0, "issue": 0, "not_visible": 0, "pending": 0}
    for item in items:
        status = item.get("status", "pending")
        if status in counts:
            counts[status] += 1
    counts["checked"] = counts["ok"] + counts["issue"]
    counts["not_checked"] = counts["pending"] + counts["not_visible"]
    return counts


def refresh_index(visit):
    checklist = read_json(visit_path(visit["visit_id"], "checklist.json"))
    summary = {
        "visit_id": visit["visit_id"],
        "company": visit["company"],
        "visit_date": visit["visit_date"],
        "visit_type": visit["visit_type"],
        "location": visit.get("location", ""),
        "status": visit["status"],
        "analyst_email": visit.get("analyst_email"),
        "analyst_name": visit.get("analyst_name", ""),
        "assignment": visit.get("assignment", "accepted"),
        "created_by": visit.get("created_by"),
        "created_at": visit["created_at"],
        "signals": len(checklist["signals"]) if checklist else None,
        "capture": _capture_state(visit["visit_id"]),
        "coverage": coverage(checklist["items"]) if checklist else None,
        "report_status": visit.get("report_status"),
    }
    index = read_json(INDEX_FILE, {"next_number": 1, "visits": []})
    index["visits"] = [v for v in index["visits"] if v["visit_id"] != visit["visit_id"]]
    index["visits"].append(summary)
    write_json(INDEX_FILE, index)


def _capture_state(visit_id):
    s = read_json(visit_path(visit_id, "capture/session.json"))
    if not s:
        return None
    if s.get("reviewed_at"):
        return "reviewed"
    return s.get("state")


def list_visits_for_user(email, role="analyst"):
    index = read_json(INDEX_FILE, {"visits": []})
    mine = [v for v in index["visits"] if role == "manager" or v.get("analyst_email") == email]
    mine.sort(key=lambda v: v.get("created_at", ""), reverse=True)
    return mine


def ensure_not_locked(visit):
    if visit.get("status") == "locked":
        raise HTTPException(409, "This visit's checklist is locked, so it can no longer be changed.")


# ---------- Audit ----------

def append_audit(visit_id, user_email, action, details=None):
    entry = {"time": now_iso(), "user": user_email, "action": action}
    if details:
        entry.update(details)
    path = visit_path(visit_id, "audit_log.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=True) + "\n")


def read_audit(visit_id):
    path = visit_path(visit_id, "audit_log.jsonl")
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def append_auth_log(user_email, action, details=None):
    entry = {"time": now_iso(), "user": user_email, "action": action}
    if details:
        entry.update(details)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(DATA_DIR / "auth_log.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=True) + "\n")
