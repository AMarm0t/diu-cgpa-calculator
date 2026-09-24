"""
Google OAuth2 ID Token Verification & Admin Authorization
"""
import asyncio
import os
import httpx
from typing import Optional, Dict, Any
from dotenv import load_dotenv
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

load_dotenv()

ADMIN_EMAILS = [e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")

if not ADMIN_EMAILS or not GOOGLE_CLIENT_ID:
    print("[AUTH] WARNING: ADMIN_EMAILS or GOOGLE_CLIENT_ID is not set - all admin access is DISABLED.")

_google_request = google_requests.Request()


def _verify_id_token(token: str) -> Optional[Dict[str, Any]]:
    """Verifies a Google ID token's signature, expiry, issuer AND audience (our client ID) locally."""
    try:
        return google_id_token.verify_oauth2_token(token, _google_request, GOOGLE_CLIENT_ID)
    except Exception:
        return None


async def _verify_access_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Verifies a Google access token via tokeninfo and requires it to have been issued to OUR client.
    Without the audience check, a token from any other Google-login site the admin used could be
    replayed here.
    """
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.post("https://oauth2.googleapis.com/tokeninfo", data={"access_token": token})
    if resp.status_code != 200:
        return None
    info = resp.json()
    if GOOGLE_CLIENT_ID not in (info.get("aud"), info.get("azp")):
        return None
    return info


async def verify_google_admin(token: str) -> Optional[Dict[str, Any]]:
    """
    Returns the admin's identity if the token is a valid Google token issued to this app, for a
    verified email on the ADMIN_EMAILS allowlist. Fails closed: with no allowlist or client ID
    configured, nobody is an admin.
    """
    if not token or not ADMIN_EMAILS or not GOOGLE_CLIENT_ID:
        return None

    try:
        payload = None
        if token.count(".") == 2:
            payload = await asyncio.to_thread(_verify_id_token, token)
        if not payload:
            payload = await _verify_access_token(token)
        if not payload:
            print("[AUTH] Rejected token: not a valid Google token issued to this app")
            return None

        email = str(payload.get("email", "")).lower()
        email_verified = payload.get("email_verified") in (True, "true")
        if not email or not email_verified:
            print("[AUTH] Rejected token: email missing or unverified")
            return None

        if email not in ADMIN_EMAILS:
            print(f"[AUTH] Rejected token: {email} is not an admin")
            return None

        return {
            "email": email,
            "name": payload.get("name", email),
            "picture": payload.get("picture", ""),
        }
    except Exception as e:
        print(f"[AUTH] Error verifying Google token: {e!r}")
        return None
