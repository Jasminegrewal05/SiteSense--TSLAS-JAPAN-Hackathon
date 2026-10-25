"""
Login for SiteSense.

Two ways to sign in, both end with the same signed, httpOnly session cookie:
  1. Email + password  (accounts in data/users.json, passwords hashed)
  2. Google sign-in    (optional, needs GOOGLE_CLIENT_ID)

Who may sign in is decided by config/access.json:
  allowed_domains : any account on these domains
  allowed_emails  : these exact addresses (e.g. a judge's Gmail)
The check runs at login AND on every request.
"""

import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from google.auth.exceptions import GoogleAuthError
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

import passwords
import settings
import storage

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "sitesense_session"

# Failed password attempts per (email, ip). 5 failures in 10 minutes -> blocked for a while.
MAX_FAILURES = 5
FAILURE_WINDOW_SECONDS = 600
_failures = {}


# ---------- helpers ----------

def _session_hours():
    return settings.get_int("SESSION_HOURS", 8)


def _serializer():
    secret = settings.get("SESSION_SECRET")
    if len(secret) < 16:
        raise HTTPException(500, "SESSION_SECRET is not set in backend/.env. Run setup_env.py.")
    return URLSafeTimedSerializer(secret, salt="sitesense-session")


def _set_session_cookie(response, user):
    response.set_cookie(
        key=COOKIE_NAME,
        value=_serializer().dumps(user),
        max_age=_session_hours() * 3600,
        httponly=True,
        secure=settings.get_bool("COOKIE_SECURE"),
        samesite="lax",
        path="/",
    )


def access_decision(email):
    """Returns (allowed, matched_by) where matched_by is 'email', 'domain' or ''."""
    access = storage.load_access()
    email = email.lower()
    if email in access["emails"]:
        return True, "email"
    if email.split("@")[-1] in access["domains"]:
        return True, "domain"
    return False, ""


def role_for(email):
    """'manager' if listed in access.json "managers" or the account says so. Else 'analyst'.
    Looked up on every request, so a role change takes effect at once."""
    email = email.lower()
    if email in storage.load_access()["managers"]:
        return "manager"
    account = next((u for u in storage.load_users() if u["email"] == email), None)
    return "manager" if account and account.get("role") == "manager" else "analyst"


def require_analyst(user):
    if user.get("role") == "manager":
        raise HTTPException(403, "Managers have view-only access to visits. Only the analyst can change them.")


def require_manager(user):
    if user.get("role") != "manager":
        raise HTTPException(403, "Only a manager can do this.")


def _recent_failures(key):
    now = time.time()
    recent = [t for t in _failures.get(key, []) if now - t < FAILURE_WINDOW_SECONDS]
    _failures[key] = recent
    return recent


def get_current_user(request: Request):
    """Dependency for every route that needs a signed-in user."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Not signed in")
    try:
        user = _serializer().loads(token, max_age=_session_hours() * 3600)
    except SignatureExpired:
        raise HTTPException(401, "Your session has expired. Sign in again.")
    except BadSignature:
        raise HTTPException(401, "Invalid session. Sign in again.")
    allowed, _ = access_decision(user["email"])
    if not allowed:
        raise HTTPException(403, "Your account no longer has access.")
    user["role"] = role_for(user["email"])
    if user.get("device_visit") and not _device_may(request.url.path, user["device_visit"]):
        raise HTTPException(403, "This phone is paired only to record visit " + user["device_visit"] + ".")
    return user


# ---------- pairing a phone by QR code (no password on the recording device) ----------
#
# The analyst's laptop asks for a one-time code for one visit. The QR code carries it.
# The phone sends it once and gets a session that can ONLY record that visit:
# the recording screen, the phone checklist, its ticks and the voice sample. Nothing else.

PAIR_MINUTES = 10
_used_pair_codes = {}


def _pair_serializer():
    secret = settings.get("SESSION_SECRET")
    if len(secret) < 16:
        raise HTTPException(500, "SESSION_SECRET is not set in backend/.env. Run setup_env.py.")
    return URLSafeTimedSerializer(secret, salt="sitesense-pair")


def _device_may(path, visit_id):
    v = re.escape(visit_id)
    allowed = (
        r"/api/auth/(me|logout|config)",
        r"/api/voice",
        r"/api/visits/" + v + r"/brief",
        r"/api/visits/" + v + r"/checklist/items/[^/]+/mark",
        r"/api/visits/" + v + r"/capture(/(start|chunks|mark|pause|end|asking|place|replay))?",
    )
    return any(re.fullmatch(a, path) for a in allowed)


def make_pair_code(user, visit_id):
    return _pair_serializer().dumps({"email": user["email"], "name": user["name"], "visit": visit_id,
                                     "nonce": secrets.token_urlsafe(8)})


class PairIn(BaseModel):
    code: str = Field(min_length=10, max_length=600)


@router.post("/pair")
def pair_phone(body: PairIn, response: Response):
    try:
        data = _pair_serializer().loads(body.code, max_age=PAIR_MINUTES * 60)
    except SignatureExpired:
        raise HTTPException(401, "This code has expired. Scan the new code on the laptop.")
    except BadSignature:
        raise HTTPException(401, "This code is not valid. Scan the code on the laptop again.")
    now = time.time()
    for k in [k for k, t in _used_pair_codes.items() if now - t > PAIR_MINUTES * 60]:
        _used_pair_codes.pop(k, None)
    if data["nonce"] in _used_pair_codes:
        raise HTTPException(401, "This code was already used. Scan the new code on the laptop.")
    allowed, _ = access_decision(data["email"])
    if not allowed:
        raise HTTPException(403, "This account no longer has access.")
    _used_pair_codes[data["nonce"]] = now
    user = {"email": data["email"], "name": data["name"], "picture": "", "method": "paired phone",
            "device_visit": data["visit"]}
    _set_session_cookie(response, user)
    storage.append_auth_log(data["email"], "phone_paired", {"visit": data["visit"]})
    storage.append_audit(data["visit"], data["email"], "phone_paired")
    return {"ok": True, "visit": data["visit"]}


# ---------- routes ----------

@router.get("/config")
def auth_config():
    return {
        "local_login": settings.get_bool("LOCAL_LOGIN", "true"),
        "google_client_id": settings.get("GOOGLE_CLIENT_ID"),
    }


class PasswordLogin(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


@router.post("/password")
def login_with_password(body: PasswordLogin, request: Request, response: Response):
    if not settings.get_bool("LOCAL_LOGIN", "true"):
        raise HTTPException(404, "Password sign-in is turned off")

    email = body.email.strip().lower()
    ip = request.client.host if request.client else "unknown"
    key = email + "|" + ip

    if len(_recent_failures(key)) >= MAX_FAILURES:
        storage.append_auth_log(email, "login_rate_limited", {"ip": ip})
        raise HTTPException(429, "Too many failed attempts. Try again in 10 minutes.")

    allowed, _ = access_decision(email)
    if not allowed:
        storage.append_auth_log(email, "login_blocked", {"reason": "domain", "ip": ip})
        raise HTTPException(403, "This email domain does not have access to SiteSense.")

    account = next((u for u in storage.load_users() if u["email"] == email), None)
    stored_hash = account["password_hash"] if account else passwords.DUMMY_HASH
    ok = passwords.verify_password(body.password, stored_hash)

    if not account or not ok or account.get("disabled"):
        _failures.setdefault(key, []).append(time.time())
        storage.append_auth_log(email, "login_failed", {"ip": ip})
        raise HTTPException(401, "Email or password is incorrect.")

    _failures.pop(key, None)
    user = {"email": email, "name": account["name"], "picture": "", "method": "password"}
    _set_session_cookie(response, user)
    storage.append_auth_log(email, "login", {"method": "password", "ip": ip})
    return {**user, "role": role_for(email)}


class GoogleLogin(BaseModel):
    credential: str


@router.post("/google")
def login_with_google(body: GoogleLogin, response: Response):
    client_id = settings.get("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(404, "Google sign-in is not set up")

    try:
        info = id_token.verify_oauth2_token(body.credential, google_requests.Request(), client_id)
    except ValueError:
        raise HTTPException(401, "Google sign-in could not be verified. Try again.")
    except GoogleAuthError:
        raise HTTPException(503, "Could not reach Google to verify sign-in. Check the internet connection.")

    email = (info.get("email") or "").lower()
    if not email or not info.get("email_verified"):
        raise HTTPException(401, "This Google account's email is not verified.")

    allowed, matched_by = access_decision(email)
    if not allowed:
        storage.append_auth_log(email, "login_blocked", {"reason": "domain", "method": "google"})
        raise HTTPException(403, "This email domain does not have access to SiteSense.")

    # For whole-domain access, insist the account is managed by that organisation.
    if matched_by == "domain" and settings.get_bool("REQUIRE_WORKSPACE_ACCOUNT", "true"):
        if (info.get("hd") or "").lower() != email.split("@")[-1]:
            storage.append_auth_log(email, "login_blocked", {"reason": "not_workspace"})
            raise HTTPException(403, "Sign in with your organisation's Google Workspace account.")

    user = {
        "email": email,
        "name": info.get("name") or email,
        "picture": info.get("picture") or "",
        "method": "google",
    }
    _set_session_cookie(response, user)
    storage.append_auth_log(email, "login", {"method": "google"})
    return {**user, "role": role_for(email)}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return user


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        try:
            storage.append_auth_log(_serializer().loads(token)["email"], "logout")
        except Exception:
            pass
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}
