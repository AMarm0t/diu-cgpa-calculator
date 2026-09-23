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
    Verifies a Google OAuth ID token.
    Checks that:
    1. The token is valid and signed by Google.
    2. The email is verified.
    3. The email is included in the ADMIN_EMAILS whitelist.
    """
    if not token:
        return None

    try:
        # Verify token using Google's tokeninfo API
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={token}")
            if resp.status_code != 200:
                print(f"[AUTH] Google tokeninfo returned status {resp.status_code}: {resp.text}")
                return None
            
            payload = resp.json()
            email = payload.get("email", "").lower()
            email_verified = payload.get("email_verified") == "true" or payload.get("email_verified") is True

            if not email or not email_verified:
                print("[AUTH] Email unverified or missing in Google payload")
                return None

            # If ADMIN_EMAILS is configured, enforce whitelist check
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
