from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

import storage
from datetime import date as _date

from fastapi import HTTPException

from auth import get_current_user, require_analyst, require_manager, role_for

router = APIRouter(prefix="/api/visits", tags=["visits"])

SECTORS = ("manufacturing", "distribution", "retail", "services")
VISIT_TYPES = ("plant", "warehouse", "office", "store")
PURPOSES = ("credit", "investment", "compliance")


class Person(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    role: str = Field("", max_length=80)


class VisitIn(BaseModel):
    company: str = Field(min_length=2, max_length=120)
    sector: Literal[SECTORS]
    visit_type: Literal[VISIT_TYPES]
    visit_date: date
    analyst_email: str | None = None  # who the manager assigns the visit to
    location: str = Field(min_length=2, max_length=120)
    purpose: Literal[PURPOSES]
    guided_tour: bool = True
    people: list[Person] = Field(default_factory=list, max_length=10)
    notes: str = Field("", max_length=1000)


def _clean(data: VisitIn):
    return {
        "company": data.company.strip(),
        "sector": data.sector,
        "visit_type": data.visit_type,
        "visit_date": data.visit_date.isoformat(),
        "location": data.location.strip(),
        "purpose": data.purpose,
        "guided_tour": data.guided_tour,
        "people": [{"name": p.name.strip(), "role": p.role.strip()} for p in data.people],
        "notes": data.notes.strip(),
    }


# ---------- service functions (also used by seed_demo.py) ----------

def find_analyst(email):
    """The assignee must be a real, enabled account whose role is analyst."""
    email = (email or "").strip().lower()
    account = next((u for u in storage.load_users() if u["email"] == email and not u.get("disabled")), None)
    if account is None or role_for(email) != "analyst":
        raise HTTPException(422, "Pick an analyst from the list.")
    return {"email": email, "name": account["name"]}


def create_visit(manager, data: VisitIn, analyst, accepted=False):
    """A manager creates the visit and assigns it. The analyst must accept before working on it."""
    now = storage.now_iso()
    visit = {
        "visit_id": storage.new_visit_id(),
        **_clean(data),
        "created_by": manager["email"],
        "created_by_name": manager["name"],
        "analyst_name": analyst["name"],
        "analyst_email": analyst["email"],
        "assignment": "accepted" if accepted else "assigned",
        "status": "draft" if accepted else "assigned",
        "docs": [],
        "created_at": now,
        "updated_at": now,
        "details_changed_at": now,
        "docs_changed_at": None,
    }
    storage.visit_dir(visit["visit_id"]).mkdir(parents=True, exist_ok=True)
    storage.save_visit(visit)
    storage.append_audit(visit["visit_id"], manager["email"], "visit_created",
                         {"company": visit["company"], "assigned_to": analyst["email"]})
    if accepted:
        storage.append_audit(visit["visit_id"], analyst["email"], "visit_accepted", {})
    return visit


def overview(visit):
    """Visit details plus where it stands in the pre-visit flow."""
    vid = visit["visit_id"]
    raw = storage.read_json(storage.visit_path(vid, "metrics_raw.json"))
    confirmed = storage.read_json(storage.visit_path(vid, "metrics.json"))
    checklist = storage.read_json(storage.visit_path(vid, "checklist.json"))

    numbers_outdated = bool(
        raw and visit.get("docs_changed_at") and visit["docs_changed_at"] > raw["extracted_at"]
    )
    checklist_outdated = False
    if checklist and checklist["status"] != "locked":
        if confirmed and confirmed["confirmed_at"] > checklist["generated_at"]:
            checklist_outdated = True
        if visit.get("details_changed_at", "") > checklist["generated_at"]:
            checklist_outdated = True

    session = storage.read_json(storage.visit_path(vid, "capture/session.json"))
    return {
        **visit,
        "progress": {
            "capture": session["state"] if session else None,
            "reviewed": bool(session and session.get("reviewed_at")),
            "docs": len(visit.get("docs", [])),
            "numbers_read": raw is not None,
            "numbers_outdated": numbers_outdated,
            "numbers_confirmed": confirmed is not None,
            "checklist": checklist["status"] if checklist else None,
            "checklist_outdated": checklist_outdated,
            "signals": len(checklist["signals"]) if checklist else 0,
            "coverage": storage.coverage(checklist["items"]) if checklist else None,
        },
    }


# ---------- routes ----------

@router.get("/analysts")
def list_analysts(user=Depends(get_current_user)):
    require_manager(user)
    return {"analysts": [{"email": u["email"], "name": u["name"]} for u in storage.load_users()
                         if not u.get("disabled") and role_for(u["email"]) == "analyst"]}


@router.get("")
def list_my_visits(user=Depends(get_current_user)):
    return {"visits": storage.list_visits_for_user(user["email"], user.get("role", "analyst"))}


@router.post("")
def create(data: VisitIn, user=Depends(get_current_user)):
    require_manager(user)
    analyst = find_analyst(data.analyst_email)
    if data.visit_date < _date.today():
        raise HTTPException(422, "The visit date must be today or a later date.")
    return overview(create_visit(user, data, analyst))


@router.get("/{visit_id}")
def get_visit(visit_id: str, user=Depends(get_current_user)):
    return overview(storage.load_visit_for_user(visit_id, user, read_only=True))


@router.put("/{visit_id}")
def update_visit(visit_id: str, data: VisitIn, user=Depends(get_current_user)):
    require_manager(user)  # the manager owns the visit details
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    storage.ensure_not_locked(visit)
    # A date that is already saved may stay as it is. A NEW date must be today or later.
    if data.visit_date.isoformat() != visit.get("visit_date") and data.visit_date < _date.today():
        raise HTTPException(422, "The visit date must be today or a later date.")
    new_values = _clean(data)
    changed = [k for k, v in new_values.items() if visit.get(k) != v]
    if changed:
        visit.update(new_values)
        visit["details_changed_at"] = storage.now_iso()
        storage.save_visit(visit)
        storage.append_audit(visit_id, user["email"], "details_edited", {"fields": changed})
    return overview(visit)


@router.get("/{visit_id}/activity")
def activity(visit_id: str, user=Depends(get_current_user)):
    storage.load_visit_for_user(visit_id, user, read_only=True)
    return {"events": list(reversed(storage.read_audit(visit_id)))}


# ---------- assignment: accept, decline, reassign ----------

class DeclineIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class ReassignIn(BaseModel):
    analyst_email: str


@router.post("/{visit_id}/accept")
def accept(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user, allow_unaccepted=True)
    if visit.get("assignment") != "assigned":
        raise HTTPException(409, "This visit is not waiting for you to accept.")
    visit["assignment"] = "accepted"
    visit["status"] = "draft"
    visit["accepted_at"] = storage.now_iso()
    storage.save_visit(visit)
    storage.append_audit(visit_id, user["email"], "visit_accepted", {})
    return overview(visit)


@router.post("/{visit_id}/decline")
def decline(visit_id: str, body: DeclineIn, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user, allow_unaccepted=True)
    if visit.get("assignment") != "assigned":
        raise HTTPException(409, "Only a visit you have not accepted yet can be declined.")
    storage.append_audit(visit_id, user["email"], "visit_declined", {"reason": body.reason.strip()})
    visit.setdefault("declined", []).append(
        {"by": user["email"], "reason": body.reason.strip(), "at": storage.now_iso()})
    visit["analyst_email"], visit["analyst_name"] = None, ""
    visit["assignment"], visit["status"] = "declined", "declined"
    storage.save_visit(visit)
    return {"ok": True}


@router.post("/{visit_id}/reassign")
def reassign(visit_id: str, body: ReassignIn, user=Depends(get_current_user)):
    require_manager(user)
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    if visit.get("assignment") == "accepted":
        raise HTTPException(409, "The analyst already accepted this visit, so it cannot be reassigned.")
    analyst = find_analyst(body.analyst_email)
    visit["analyst_email"], visit["analyst_name"] = analyst["email"], analyst["name"]
    visit["assignment"], visit["status"] = "assigned", "assigned"
    storage.save_visit(visit)
    storage.append_audit(visit_id, user["email"], "visit_reassigned", {"assigned_to": analyst["email"]})
    return overview(visit)


# ---------- legal hold ----------

class LegalHoldIn(BaseModel):
    on: bool
    reason: str = Field("", max_length=300)


@router.put("/{visit_id}/legal-hold")
def legal_hold(visit_id: str, body: LegalHoldIn, user=Depends(get_current_user)):
    """While on hold, nothing can delete this visit's kept clips or results (a dispute or audit is open).
    The manager or the assigned analyst can set it."""
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    if bool(visit.get("legal_hold")) != body.on:
        visit["legal_hold"] = body.on
        visit["legal_hold_reason"] = body.reason.strip() if body.on else ""
        visit["legal_hold_changed_at"] = storage.now_iso()
        storage.save_visit(visit)
        storage.append_audit(visit_id, user["email"], "legal_hold_on" if body.on else "legal_hold_off",
                             {"reason": body.reason.strip()} if body.on else None)
    return overview(visit)
