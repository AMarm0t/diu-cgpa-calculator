"""
Admin sign-in with email + password, as an alternative to Google.

- Only emails on ADMIN_EMAILS can have a password, and only an admin signed in with Google can set,
  change or remove it. A password session cannot, so a stolen session can't lock the owner out.
- Passwords are hashed like student passwords: scrypt + per-record salt + the server pepper.
- Signing in hands out a random session token (12 h). Only its SHA-256 is stored, so the database
  never holds a usable token. Changing or removing the password ends that admin's sessions, and an
  email taken off ADMIN_EMAILS loses access at once.
- Guessing is capped per email (5 failures lock password sign-in for 15 min, shared by all servers
  through the database) and per IP (in app.py), and a wrong email costs the same time as a wrong
  password, so the reply never reveals which emails are admins.

Everything lives in one app row of student_results (db.ADMIN_AUTH_ID), which admin endpoints can't
reach (their student IDs can't contain "_") and the student list leaves out.
"""
import hashlib
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import db
from auth import ADMIN_EMAILS

TOKEN_PREFIX = "rsadm_"
SESSION_SECONDS = 12 * 3600
MAX_FAILURES = 5
LOCK_SECONDS = 15 * 60
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128  # also bounds the hashing work one request can cause
SESSION_CHECK_SECONDS = 30  # how long a server trusts its last look at a session

_lock = threading.Lock()  # one read-modify-write of the auth row at a time on this server
_session_checks: Dict[str, tuple] = {}
# Verified against when there is no real hash, so every sign-in attempt costs one scrypt
_DUMMY_HASH = db.hash_password(secrets.token_hex(16))


def _load() -> Dict[str, Any]:
    data = db.get_admin_auth()
    if not isinstance(data.get("accounts"), dict):
        data["accounts"] = {}
    if not isinstance(data.get("sessions"), dict):
        data["sessions"] = {}
    return data


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _end_sessions(data: Dict[str, Any], email: str) -> None:
    data["sessions"] = {h: s for h, s in data["sessions"].items() if s.get("email") != email}
    _session_checks.clear()


def password_problem(password: str, email: str) -> Optional[str]:
    """Why a new password is too weak, or None if it is acceptable."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Use at most {MAX_PASSWORD_LENGTH} characters."
    if len(set(password)) < 6:
        return "That password is too simple. Mix more different characters."
    name = email.split("@")[0].lower()
    if len(name) >= 4 and name in password.lower():
        return "Don't use your email address in the password."
    return None


def status(email: str) -> Dict[str, Any]:
    account = _load()["accounts"].get(email) or {}
    return {"has_password": bool(account.get("hash")), "updated_at": account.get("updated_at")}


def set_password(email: str, password: str) -> None:
    """Sets or replaces an admin's password and signs out their existing password sessions."""
    with _lock:
        data = _load()
        data["accounts"][email] = {
            "hash": db.hash_password(password),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "failed": 0,
            "locked_until": 0,
        }
        _end_sessions(data, email)
        if not db.save_admin_auth(data):
            raise RuntimeError("could not save the admin password")
    print(f"[ADMIN-AUTH] {email}: password set")


def remove_password(email: str) -> None:
    with _lock:
        data = _load()
        data["accounts"].pop(email, None)
        _end_sessions(data, email)
        if not db.save_admin_auth(data):
            raise RuntimeError("could not remove the admin password")
    print(f"[ADMIN-AUTH] {email}: password removed")


def login(email: str, password: str) -> Optional[Dict[str, Any]]:
    """Checks an email + password; returns a new session, or None (never says why)."""
    email = email.strip().lower()
    now = time.time()
    with _lock:
        data = _load()
        account = data["accounts"].get(email) if email in ADMIN_EMAILS else None
        stored = (account or {}).get("hash")
        locked = bool(account) and float(account.get("locked_until") or 0) > now
        usable = bool(stored) and not locked
        # One scrypt either way: unknown, locked and real emails take the same time
        matches = db.verify_password(password, stored if usable else _DUMMY_HASH)
        if not account:
            return None
        if not (usable and matches):
            if not locked:
                account["failed"] = int(account.get("failed") or 0) + 1
                if account["failed"] >= MAX_FAILURES:
                    account["failed"] = 0
                    account["locked_until"] = now + LOCK_SECONDS
                    print(f"[ADMIN-AUTH] {email}: password sign-in paused for 15 minutes after {MAX_FAILURES} failures")
                db.save_admin_auth(data)
            return None

        account["failed"] = 0
        account["locked_until"] = 0
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        data["sessions"] = {h: s for h, s in data["sessions"].items() if float(s.get("expires") or 0) > now}
        data["sessions"][_token_hash(token)] = {
            "email": email,
            "expires": now + SESSION_SECONDS,
            "password_set": account.get("updated_at"),
        }
        if not db.save_admin_auth(data):
            return None
    print(f"[ADMIN-AUTH] {email}: signed in with password")
    return {"token": token, "expires_at": int(now + SESSION_SECONDS), "email": email}


def session_admin(token: str) -> Optional[Dict[str, Any]]:
    """The admin behind a password-session token, or None if it is unknown, expired or revoked."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 100:
        return None
    key = _token_hash(token)
    now = time.time()
    checked = _session_checks.get(key)
    if checked and now - checked[0] < SESSION_CHECK_SECONDS:
        session = checked[1]
    else:
        data = _load()
        session = data["sessions"].get(key)
        account = data["accounts"].get((session or {}).get("email")) or {}
        # A session only lives as long as the password it was opened with
        if session and (not account.get("hash") or account.get("updated_at") != session.get("password_set")):
            session = None
        if len(_session_checks) > 1000:
            _session_checks.clear()
        _session_checks[key] = (now, session)
    if not session or float(session.get("expires") or 0) <= now:
        return None
    email = session.get("email", "")
    if email not in ADMIN_EMAILS:
        return None
    return {"email": email, "name": email, "picture": "", "method": "password",
            "expires_at": int(float(session["expires"]))}


def logout(token: str) -> None:
    if not token.startswith(TOKEN_PREFIX):
        return
    key = _token_hash(token)
    with _lock:
        data = _load()
        if data["sessions"].pop(key, None) is not None:
            db.save_admin_auth(data)
    _session_checks.pop(key, None)
