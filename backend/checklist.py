"""
Turns confirmed numbers into risk signals and a checklist, then lets the
analyst edit, lock and (during the visit) mark each item by hand.

Item status during the visit:
  pending      not looked at yet         -> counts as NOT checked
  ok           checked, looks fine       -> checked
  issue        checked, problem found    -> checked
  not_visible  tried, could not confirm  -> counts as NOT checked

A mark made by hand always wins: an accepted suggestion (Phase 2) never replaces it.
"""

import re
from typing import Literal, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import finance
import settings
import storage
from auth import get_current_user, require_analyst, require_manager

router = APIRouter(prefix="/api/visits", tags=["checklist"])

AREAS = ["Production floor", "Warehouse", "Dispatch", "Store floor", "Office",
         "Management questions", "General"]
KINDS = ("look_for", "ask")
PRIORITIES = ("high", "medium", "low")
STATUSES = ("pending", "ok", "issue", "not_visible")
PLACEHOLDER = re.compile(r"\{([a-z_]+)\.(current|previous|change|change_pct)\}")
OPS = {
    ">": lambda a, b: a > b, ">=": lambda a, b: a >= b,
    "<": lambda a, b: a < b, "<=": lambda a, b: a <= b,
}


def load_rules():
    with open(storage.CONFIG_DIR / "rules.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _value(computed, ref):
    key, field = ref.split(".")
    entry = computed.get(key)
    return None if entry is None else entry.get(field)


def evaluate(when, computed):
    """Returns (result, missing_metric_keys). result is True/False, or None if data is missing."""
    mode = "all" if "all" in when else "any"
    results, missing = [], []
    for cond in when[mode]:
        v = _value(computed, cond["metric"])
        if v is None:
            missing.append(cond["metric"].split(".")[0])
            results.append(None)
        else:
            results.append(OPS[cond["op"]](v, cond["value"]))
    if mode == "all":
        if False in results:
            return False, []
        return (None, missing) if missing else (True, [])
    if True in results:
        return True, []
    return (None, missing) if missing else (False, [])


def render(text, computed):
    def repl(m):
        entry = computed.get(m.group(1))
        return "n/a" if entry is None else finance.fmt_field(entry, m.group(2))
    return PLACEHOLDER.sub(repl, text)


def _figures(when, computed):
    """The number movements behind a signal, for the 'why' column."""
    seen, figures = set(), []
    for cond in when.get("all", []) + when.get("any", []):
        key = cond["metric"].split(".")[0]
        if key in seen:
            continue
        seen.add(key)
        e = computed[key]
        figures.append({
            "label": e["label"],
            "previous": finance.fmt_field(e, "previous") if e["previous"] is not None else None,
            "current": finance.fmt_field(e, "current"),
        })
    return figures


def _sources(when, confirmed):
    out = []
    for cond in when.get("all", []) + when.get("any", []):
        for base_key in finance.inputs_of(cond["metric"].split(".")[0]):
            src = confirmed["metrics"][base_key]["source"]
            if src and src not in out:
                out.append(src)
    return out


def _new_item(area, kind, text, priority, origin, signal_id=None, why=None, sources=None,
              topics=None, vision=None):
    # topics: words that tell us this item is being discussed (Phase 2 transcript)
    # vision: a fixed-option question for the picture check (Phase 2)
    return {
        "id": None, "area": area, "kind": kind, "text": text, "priority": priority,
        "origin": origin, "signal_id": signal_id, "why": why, "sources": sources or [],
        "topics": topics or [], "vision": vision,
        "status": "pending", "note": "", "marked_by": None, "marked_at": None, "history": [],
    }


def _sort_and_number(items):
    order = {a: i for i, a in enumerate(AREAS)}
    prio = {p: i for i, p in enumerate(PRIORITIES)}
    items.sort(key=lambda it: (order.get(it["area"], 99), prio.get(it["priority"], 9),
                               0 if it["kind"] == "look_for" else 1))
    for i, it in enumerate(items, start=1):
        it["id"] = "CHK-" + str(i).zfill(2)
    return items


def generate(visit, user):
    storage.ensure_not_locked(visit)
    vid = visit["visit_id"]
    confirmed = storage.read_json(storage.visit_path(vid, "metrics.json"))
    if confirmed is None:
        raise HTTPException(400, "Confirm the numbers first.")
    computed = confirmed["derived"]
    cfg = load_rules()
    vt = visit["visit_type"]

    signals, not_triggered, skipped, items = [], [], [], []
    for rule in cfg["rules"]:
        result, missing = evaluate(rule["when"], computed)
        if result is None:
            skipped.append({"id": rule["id"], "signal": rule["signal"],
                            "needs": sorted({finance.LABELS.get(k) or finance.DERIVED[k][0] for k in missing})})
            continue
        if not result:
            not_triggered.append({"id": rule["id"], "signal": rule["signal"]})
            continue
        evidence = render(rule["evidence"], computed)
        sources = _sources(rule["when"], confirmed)
        signals.append({
            "id": rule["id"], "signal": rule["signal"], "severity": rule["severity"],
            "evidence": evidence, "figures": _figures(rule["when"], computed), "sources": sources,
        })
        for it in rule["items"]:
            if it.get("visit_types") and vt not in it["visit_types"]:
                continue
            items.append(_new_item(it["area"], it["kind"], render(it["text"], computed),
                                   rule["severity"], "rule", rule["id"], evidence, sources,
                                   topics=rule.get("topics"), vision=it.get("vision")))

    for it in cfg["baseline"].get(vt, []) + cfg["baseline"].get("all", []):
        items.append(_new_item(it["area"], it["kind"], it["text"], "low", "baseline",
                               topics=it.get("topics"), vision=it.get("vision")))
    if visit.get("guided_tour"):
        for it in cfg.get("guided_tour", []):
            items.append(_new_item(it["area"], it["kind"], it["text"], "medium", "baseline"))

    severity_order = {"high": 0, "medium": 1, "low": 2}
    signals.sort(key=lambda s: severity_order[s["severity"]])

    items = _sort_and_number(items)
    checklist = {
        "status": "draft",
        "generated_at": storage.now_iso(),
        "generated_by": user["email"],
        "visit_type": vt,
        "rules_checked": len(cfg["rules"]),
        "signals": signals,
        "not_triggered": not_triggered,
        "skipped": skipped,
        "items": items,
        "places": default_places(items),
        "locked_at": None,
        "locked_by": None,
    }
    storage.write_json(storage.visit_path(vid, "checklist.json"), checklist)
    visit["status"] = "checklist_ready"
    storage.save_visit(visit)
    storage.append_audit(vid, user["email"], "checklist_built", {
        "signals": len(signals), "items": len(checklist["items"]),
    })
    return checklist


NOT_PLACES = {"Management questions", "General"}


def default_places(items):
    """Places to see: every on-site area the checklist sends the analyst to, with the
    warning sign that makes it matter. The analyst can rename, add or remove them."""
    out = []
    for it in items:
        if it["area"] in NOT_PLACES:
            continue
        found = next((p for p in out if p["name"] == it["area"]), None)
        if found is None:
            out.append({"name": it["area"], "note": it.get("why") or ""})
        elif not found["note"] and it.get("why"):
            found["note"] = it["why"]
    return out


def load_checklist(visit):
    checklist = storage.read_json(storage.visit_path(visit["visit_id"], "checklist.json"))
    if checklist is None:
        raise HTTPException(404, "No checklist yet. Build it from the confirmed numbers.")
    if "places" not in checklist:
        checklist["places"] = default_places(checklist["items"])
    return checklist


def _reset_approval(visit, user, checklist):
    """Any edit after submitting sends the checklist back to draft: the manager must approve what is final."""
    if checklist["status"] in ("submitted", "approved"):
        checklist["status"] = "draft"
        for k in ("submitted_at", "submitted_by", "approved_at", "approved_by"):
            checklist.pop(k, None)
        visit["status"] = "checklist_ready"
        storage.save_visit(visit)
        storage.append_audit(visit["visit_id"], user["email"], "approval_reset", {})


class PlaceIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    note: str = Field("", max_length=200)


def save_places(visit, user, places_in):
    storage.ensure_not_locked(visit)
    checklist = load_checklist(visit)
    clean, seen = [], set()
    for p in places_in:
        name = p.name.strip()
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        clean.append({"name": name, "note": p.note.strip()})
    checklist["places"] = clean
    _reset_approval(visit, user, checklist)
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    storage.append_audit(visit["visit_id"], user["email"], "places_edited", {"places": len(clean)})
    return checklist


class ItemIn(BaseModel):
    id: Optional[str] = None
    area: Literal[tuple(AREAS)]
    kind: Literal[KINDS]
    text: str = Field(min_length=3, max_length=400)
    priority: Literal[PRIORITIES]


def save_items(visit, user, items_in):
    storage.ensure_not_locked(visit)
    checklist = load_checklist(visit)
    existing = {it["id"]: it for it in checklist["items"]}
    used_numbers = [int(i.split("-")[1]) for i in existing]
    next_no = max(used_numbers, default=0) + 1

    new_items, kept = [], set()
    for data in items_in:
        if data.id in existing:
            it = existing[data.id]
            changes = {f: getattr(data, f) for f in ("area", "kind", "text", "priority")
                       if it[f] != getattr(data, f)}
            if changes:
                it.update(changes)
                if it["origin"] != "analyst":
                    it["edited"] = True
                storage.append_audit(visit["visit_id"], user["email"], "item_edited",
                                     {"item": it["id"], "fields": list(changes)})
            kept.add(data.id)
            new_items.append(it)
        else:
            it = _new_item(data.area, data.kind, data.text.strip(), data.priority, "analyst")
            it["id"] = "CHK-" + str(next_no).zfill(2)
            next_no += 1
            storage.append_audit(visit["visit_id"], user["email"], "item_added", {"item": it["id"]})
            new_items.append(it)

    for item_id in existing:
        if item_id not in kept:
            storage.append_audit(visit["visit_id"], user["email"], "item_removed",
                                 {"item": item_id, "text": existing[item_id]["text"]})

    checklist["items"] = new_items
    _reset_approval(visit, user, checklist)
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    storage.refresh_index(visit)
    return checklist


def submit(visit, user):
    storage.ensure_not_locked(visit)
    checklist = load_checklist(visit)
    if not checklist["items"]:
        raise HTTPException(400, "The checklist is empty.")
    if checklist["status"] != "draft":
        raise HTTPException(409, "This checklist is already submitted or approved.")
    checklist["status"] = "submitted"
    checklist["submitted_at"] = storage.now_iso()
    checklist["submitted_by"] = user["email"]
    checklist.pop("review_note", None)
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    visit["status"] = "submitted"
    storage.save_visit(visit)
    storage.append_audit(visit["visit_id"], user["email"], "checklist_submitted", {"items": len(checklist["items"])})
    return checklist


def review(visit, manager, approve, note=""):
    """A manager approves, or sends back with a note. Never their own visit."""
    if visit.get("analyst_email") == manager["email"]:
        raise HTTPException(403, "You cannot approve your own visit.")
    checklist = load_checklist(visit)
    if checklist["status"] != "submitted":
        raise HTTPException(409, "Only a submitted checklist can be reviewed.")
    if approve:
        checklist["status"] = "approved"
        checklist["approved_at"] = storage.now_iso()
        checklist["approved_by"] = manager["email"]
        checklist["approval_note"] = note.strip()  # optional comment for the analyst
        checklist.pop("review_note", None)
        visit["status"] = "approved"
    else:
        if not note.strip():
            raise HTTPException(400, "Add a short note saying what to change.")
        checklist["status"] = "draft"
        checklist["review_note"] = note.strip()
        visit["status"] = "checklist_ready"
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    storage.save_visit(visit)
    storage.append_audit(visit["visit_id"], manager["email"],
                         "checklist_approved" if approve else "checklist_sent_back",
                         {"note": note.strip()} if note.strip() else {})
    return checklist


def lock(visit, user, skip_approval=False):
    storage.ensure_not_locked(visit)
    checklist = load_checklist(visit)
    if not checklist["items"]:
        raise HTTPException(400, "The checklist is empty.")
    if settings.get_bool("REQUIRE_APPROVAL", "true") and not skip_approval and checklist["status"] != "approved":
        raise HTTPException(409, "A manager must approve the checklist before it can be locked.")
    approved_at = checklist.get("approved_at", "")
    if approved_at and not skip_approval and (visit.get("details_changed_at", "") > approved_at
                                              or (visit.get("docs_changed_at") or "") > approved_at):
        raise HTTPException(409, "The visit details or documents changed after approval. Submit again for approval.")
    checklist["status"] = "locked"
    checklist["locked_at"] = storage.now_iso()
    checklist["locked_by"] = user["email"]
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    visit["status"] = "locked"
    storage.save_visit(visit)
    storage.append_audit(visit["visit_id"], user["email"], "checklist_locked",
                         {"items": len(checklist["items"])})
    return checklist


def mark_item(visit, user, item_id, status, note="", source="manual"):
    checklist = load_checklist(visit)
    if checklist["status"] != "locked":
        raise HTTPException(409, "Lock the checklist before marking items.")
    item = next((it for it in checklist["items"] if it["id"] == item_id), None)
    if item is None:
        raise HTTPException(404, "Checklist item not found")
    if source != "manual" and item.get("marked_by") == "manual":
        raise HTTPException(409, "You already marked this item by hand, so the suggestion was not applied.")

    now = storage.now_iso()
    item["status"] = status
    item["note"] = note.strip()
    item["marked_by"] = None if status == "pending" else source
    item["marked_at"] = None if status == "pending" else now
    item.setdefault("history", []).append(
        {"at": now, "by": user["email"], "source": source, "status": status, "note": item["note"]}
    )
    storage.write_json(storage.visit_path(visit["visit_id"], "checklist.json"), checklist)
    storage.refresh_index(visit)
    storage.append_audit(visit["visit_id"], user["email"], "item_marked",
                         {"item": item_id, "status": status, "source": source})
    return item


def consent_script(visit):
    org = settings.get("ORG_NAME", "Value Create")
    return (
        "Before we start: I am " + visit["analyst_name"] + " from " + org + ". "
        "With your permission, I will record short video and audio clips during this visit "
        "to support my notes. Faces are blurred automatically, the full recording is deleted "
        "after processing, and only short clips are kept for our review. "
        "Is everyone here comfortable with that?"
    )


# ---------- routes ----------

@router.post("/{visit_id}/checklist/generate")
def build(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    return generate(storage.load_visit_for_user(visit_id, user), user)


@router.get("/{visit_id}/checklist")
def get_checklist(visit_id: str, user=Depends(get_current_user)):
    return load_checklist(storage.load_visit_for_user(visit_id, user, read_only=True))


class ItemsIn(BaseModel):
    items: list[ItemIn] = Field(max_length=200)


class PlacesIn(BaseModel):
    places: list[PlaceIn] = Field(max_length=30)


@router.put("/{visit_id}/checklist/places")
def put_places(visit_id: str, body: PlacesIn, user=Depends(get_current_user)):
    require_analyst(user)
    return save_places(storage.load_visit_for_user(visit_id, user), user, body.places)


@router.put("/{visit_id}/checklist")
def put_items(visit_id: str, body: ItemsIn, user=Depends(get_current_user)):
    require_analyst(user)
    return save_items(storage.load_visit_for_user(visit_id, user), user, body.items)


@router.post("/{visit_id}/checklist/lock")
def lock_route(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    return lock(storage.load_visit_for_user(visit_id, user), user)


@router.post("/{visit_id}/checklist/submit")
def submit_route(visit_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    return submit(storage.load_visit_for_user(visit_id, user), user)


class ReviewIn(BaseModel):
    approve: bool
    note: str = Field("", max_length=500)


@router.post("/{visit_id}/checklist/review")
def review_route(visit_id: str, body: ReviewIn, user=Depends(get_current_user)):
    require_manager(user)
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    return review(visit, user, body.approve, body.note)


class MarkIn(BaseModel):
    status: Literal[STATUSES]
    note: str = Field("", max_length=500)


@router.put("/{visit_id}/checklist/items/{item_id}/mark")
def mark_route(visit_id: str, item_id: str, body: MarkIn, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    # Ticks are made on site: only while the visit is being recorded on the phone.
    session = storage.read_json(storage.visit_path(visit_id, "capture/session.json"))
    if not session or session.get("state") not in ("recording", "paused"):
        raise HTTPException(409, "Ticks are made during the visit. Start the visit on the phone first.")
    return mark_item(visit, user, item_id, body.status, body.note, source="manual")


@router.get("/{visit_id}/brief")
def brief(visit_id: str, user=Depends(get_current_user)):
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    checklist = load_checklist(visit)
    if checklist["status"] != "locked":
        raise HTTPException(409, "Lock the checklist to open the visit brief.")
    present = [a for a in AREAS if any(it["area"] == a for it in checklist["items"])]
    return {
        "visit": {k: visit[k] for k in ("visit_id", "company", "visit_type", "visit_date",
                                        "location", "analyst_name", "people", "guided_tour")},
        "consent_script": consent_script(visit),
        "signals": checklist["signals"],
        "areas": present,
        "items": checklist["items"],
        "places": checklist.get("places", []),
        "coverage": storage.coverage(checklist["items"]),
        "locked_at": checklist["locked_at"],
    }
