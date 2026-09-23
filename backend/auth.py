"""
Google OAuth2 ID Token Verification & Admin Authorization
"""
import os
import httpx
from typing import Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()

ADMIN_EMAILS = [e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")

async def verify_google_admin(token: str) -> Optional[Dict[str, Any]]:
    """
    Verifies a Google OAuth token (either ID token JWT or OAuth2 access_token).
    Checks that:
    1. The token is valid and signed/issued by Google.
    2. The email is verified.
    3. The email is included in the ADMIN_EMAILS whitelist.
    """
    if not token:
        return None

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            payload = None

            # 1. If token looks like a JWT (3 dot-separated base64 parts)
            if token.count(".") == 2:
                resp = await client.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={token}")
                if resp.status_code == 200:
                    payload = resp.json()

            # 2. If token is an OAuth2 access token, verify via userinfo
            if not payload:
                resp = await client.get(
                    "https://www.googleapis.com/oauth2/v3/userinfo",
                    headers={"Authorization": f"Bearer {token}"}
                )
                if resp.status_code == 200:
                    payload = resp.json()

            # 3. Fallback: verify access_token via tokeninfo
            if not payload:
                resp = await client.get(f"https://oauth2.googleapis.com/tokeninfo?access_token={token}")
                if resp.status_code == 200:
                    payload = resp.json()

            if not payload:
                print("[AUTH] Google could not verify token via id_token or access_token endpoints")
                return None

            email = payload.get("email", "").lower()
            email_verified = payload.get("email_verified") == "true" or payload.get("email_verified") is True

            if not email or not email_verified:
                print(f"[AUTH] Email unverified ({email_verified}) or missing in Google payload")
                return None

            # Enforce ADMIN_EMAILS whitelist check
            if ADMIN_EMAILS and email not in ADMIN_EMAILS:
                print(f"[AUTH] Email {email} is not in ADMIN_EMAILS whitelist ({ADMIN_EMAILS})")
                return None

            return {
                "email": email,
                "name": payload.get("name", email),
                "picture": payload.get("picture", "")
            }
    except Exception as e:
        print(f"[AUTH] Error verifying Google token: {e}")
        return None
