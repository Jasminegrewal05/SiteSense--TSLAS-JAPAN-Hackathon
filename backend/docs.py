"""
Document upload. Files are checked, then stored ENCRYPTED on disk.
Only .pdf and .xlsx are accepted for now.
"""

import hashlib
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

import settings
import storage
from auth import get_current_user, require_analyst

router = APIRouter(prefix="/api", tags=["documents"])

DOC_TYPES = ("financials_excel", "annual_report", "other")
MAGIC = {".pdf": b"%PDF", ".xlsx": b"PK\x03\x04"}


def _safe_name(filename):
    name = Path(filename or "file").name
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip() or "file"
    return name[-100:]


UNITS = ("crore", "lakh", "million", "rupees")


def add_document(visit, user, filename, content, doc_type="", unit="crore"):
    storage.ensure_not_locked(visit)
    name = _safe_name(filename)
    ext = Path(name).suffix.lower()
    if ext not in MAGIC:
        raise HTTPException(400, "Only PDF (.pdf) and Excel (.xlsx) files can be uploaded.")
    if not content.startswith(MAGIC[ext]):
        raise HTTPException(400, name + " does not look like a real " + ext + " file.")
    max_mb = settings.get_int("MAX_UPLOAD_MB", 15)
    if len(content) > max_mb * 1024 * 1024:
        raise HTTPException(413, "File is larger than " + str(max_mb) + " MB.")

    if unit not in UNITS:
        unit = "crore"
    if doc_type not in DOC_TYPES:
        doc_type = "financials_excel" if ext == ".xlsx" else "annual_report"

    doc_id = "DOC-" + secrets.token_hex(4)
    storage.write_encrypted(storage.visit_path(visit["visit_id"], "docs/" + doc_id + ".enc"), content)

    meta = {
        "doc_id": doc_id,
        "filename": name,
        "ext": ext,
        "doc_type": doc_type,
        "unit": unit,  # what the money figures in this file are written in
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "uploaded_at": storage.now_iso(),
        "uploaded_by": user["email"],
    }
    visit.setdefault("docs", []).append(meta)
    visit["docs_changed_at"] = meta["uploaded_at"]
    storage.save_visit(visit)
    storage.append_audit(
        visit["visit_id"], user["email"], "doc_uploaded",
        {"file": name, "doc_id": doc_id, "sha256": meta["sha256"]},
    )
    return meta


def read_document(visit, doc_id):
    if not storage.DOC_ID_RE.match(doc_id or ""):
        raise HTTPException(404, "Document not found")
    meta = next((d for d in visit.get("docs", []) if d["doc_id"] == doc_id), None)
    if not meta:
        raise HTTPException(404, "Document not found")
    content = storage.read_encrypted(storage.visit_path(visit["visit_id"], "docs/" + doc_id + ".enc"))
    return meta, content


@router.post("/visits/{visit_id}/docs")
async def upload(
    visit_id: str,
    file: UploadFile = File(...),
    doc_type: str = Form(""),
    unit: str = Form("crore"),
    user=Depends(get_current_user),
):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    max_bytes = settings.get_int("MAX_UPLOAD_MB", 15) * 1024 * 1024
    content = await file.read(max_bytes + 1)
    return add_document(visit, user, file.filename, content, doc_type, unit)


@router.delete("/visits/{visit_id}/docs/{doc_id}")
def remove(visit_id: str, doc_id: str, user=Depends(get_current_user)):
    require_analyst(user)
    visit = storage.load_visit_for_user(visit_id, user)
    storage.ensure_not_locked(visit)
    meta, _ = read_document(visit, doc_id)
    storage.visit_path(visit_id, "docs/" + doc_id + ".enc").unlink(missing_ok=True)
    visit["docs"] = [d for d in visit["docs"] if d["doc_id"] != doc_id]
    visit["docs_changed_at"] = storage.now_iso()
    storage.save_visit(visit)
    storage.append_audit(visit_id, user["email"], "doc_removed", {"file": meta["filename"], "doc_id": doc_id})
    return {"ok": True}


@router.get("/visits/{visit_id}/docs/{doc_id}/file")
def download(visit_id: str, doc_id: str, user=Depends(get_current_user)):
    visit = storage.load_visit_for_user(visit_id, user, read_only=True)
    meta, content = read_document(visit, doc_id)
    storage.append_audit(visit_id, user["email"], "doc_opened", {"file": meta["filename"]})
    media = "application/pdf" if meta["ext"] == ".pdf" else (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    disposition = "inline" if meta["ext"] == ".pdf" else "attachment"
    return Response(
        content,
        media_type=media,
        headers={"Content-Disposition": disposition + '; filename="' + meta["filename"] + '"'},
    )


@router.get("/template")
def template(user=Depends(get_current_user)):
    path = storage.DEMO_DIR / "SiteSense_Financials_Template.xlsx"
    if not path.exists():
        raise HTTPException(404, "Template file is missing. Run tools/make_demo_files.py.")
    return FileResponse(path, filename="SiteSense_Financials_Template.xlsx")
