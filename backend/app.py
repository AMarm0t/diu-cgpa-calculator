"""
DIU CGPA Calculator - FastAPI Backend
Provides API endpoint for the frontend to trigger portal scraping.
"""
import asyncio
import ipaddress
import json
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path

# Add current directory to sys.path for local module imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
load_dotenv()

from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import db
from auth import verify_google_admin
from queue_manager import queue_manager
from scraper import DIUHeadlessScraper, dispatch_remote_click
from browser_pool import browser_pool
from cgpa_calculator import calculate_overall_cgpa

# Request models. Strict bounds keep junk out of the browser login, gateway URLs and the database.
class ScrapeRequest(BaseModel):
    student_id: str = Field(..., min_length=3, max_length=24, pattern=r"^\s*[A-Za-z0-9-]+\s*$")
    password: str = Field(..., min_length=1, max_length=128)

class CaptchaClickRequest(BaseModel):
    session_id: str = Field(..., min_length=36, max_length=36)
    x: float = Field(..., ge=0, le=10000)
    y: float = Field(..., ge=0, le=10000)

class ManualCourse(BaseModel):
    code: str = Field("", max_length=32)
    name: str = Field("", max_length=200)
    credits: float = Field(0, ge=0, le=20)
    grade: str = Field("", max_length=4)
    grade_point: float = Field(0, ge=0, le=4)

class ManualSemester(BaseModel):
    name: str = Field("", max_length=100)
    gpa: float = Field(0, ge=0, le=4)
    credits: float = Field(0, ge=0, le=100)
    courses: list[ManualCourse] = Field(default_factory=list, max_length=40)

class ManualCgpaRequest(BaseModel):
    semesters: list[ManualSemester] = Field(..., min_length=1, max_length=30)

# FastAPI app
app = FastAPI(
    title="DIU CGPA Calculator",
    description="Headless Scraper & CGPA Calculator for DIU",
    version="2.0.0",
)

# Only our own frontends may call the API from a browser. Override with a comma-separated list.
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,https://www.resultscraper.app,https://resultscraper.app,"
        "https://diu-cgpa-calculator-three.vercel.app",
    ).split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


# --- Per-IP rate limiting (each login launches a whole browser, so floods are expensive) ---
LOGIN_RATE_LIMIT = int(os.environ.get("LOGIN_RATE_LIMIT_PER_MIN", "6"))
CLICK_RATE_LIMIT = 40
_rate_windows: dict[tuple[str, str], deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    """
    Real client IP. Behind a Cloudflare tunnel (or Docker's port mapping) requests arrive from a
    loopback/private address, so proxy headers are trusted only then; a caller reaching us from
    a public address could forge them.
    """
    peer = request.client.host if request.client else "unknown"
    try:
        addr = ipaddress.ip_address(peer)
        via_local_proxy = addr.is_loopback or addr.is_private
    except ValueError:
        via_local_proxy = False
    if via_local_proxy:
        forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return peer


def enforce_rate_limit(request: Request, bucket: str, limit_per_min: int):
    now = time.monotonic()
    window = _rate_windows[(bucket, client_ip(request))]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= limit_per_min:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a minute and try again.")
    window.append(now)
    if len(_rate_windows) > 20000:  # bound memory under a wide flood
        for key in [k for k, w in _rate_windows.items() if not w or now - w[-1] > 60]:
            del _rate_windows[key]

@app.get("/")
async def root():
    return {"status": "ok", "service": "DIU CGPA Calculator API (Headless)"}

@app.post("/api/scrape-stream")
async def scrape_stream_endpoint(request: ScrapeRequest, http_request: Request, authorization: Optional[str] = Header(None)):
    enforce_rate_limit(http_request, "login", LOGIN_RATE_LIMIT)

    # Check if public searches are currently enabled
    settings = await asyncio.to_thread(db.get_system_settings)
    if not settings.get("public_search_enabled", True):
        is_admin = False
        if authorization and authorization.startswith("Bearer "):
            admin_data = await verify_google_admin(authorization.split()[1])
            if admin_data:
                is_admin = True
        if not is_admin:
            async def disabled_generator():
                yield f"data: {json.dumps({'type': 'error', 'message': 'Unable to connect to DIU Student Portal. Please try again later.'})}\n\n"
            return StreamingResponse(
                disabled_generator(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no"
                }
            )

    scraper = DIUHeadlessScraper()
    async def event_generator():
        # Flush initial 2KB SSE comment padding immediately.
        # This forces WebKit/Safari (on iPad & iOS) and Cloudflare proxies
        # to immediately dispatch stream chunks without buffering.
        yield f": {' ' * 2048}\n\n"
        try:
            async for item in scraper.scrape_stream(request.student_id.strip(), request.password.strip()):
                yield f"data: {json.dumps(item)}\n\n"
        except Exception as e:
            print(f"[STREAM] Unhandled scrape error: {e!r}")
            yield f"data: {json.dumps({'type': 'error', 'message': 'Something went wrong. Please try again.'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/captcha-click")
async def captcha_click_endpoint(req: CaptchaClickRequest, http_request: Request):
    enforce_rate_limit(http_request, "click", CLICK_RATE_LIMIT)
    success = dispatch_remote_click(req.session_id, req.x, req.y)
    if not success:
        raise HTTPException(status_code=404, detail="Active browser session not found or timed out.")
    return {"status": "ok", "message": "Click dispatched to browser"}


@app.post("/api/calculate-cgpa")
async def calculate_cgpa_manual(data: ManualCgpaRequest):
    """
    Manually calculate CGPA from provided grade data.
    For users who want to enter their grades manually.
    """
    try:
        return calculate_overall_cgpa([sem.model_dump() for sem in data.semesters])
    except Exception:
        raise HTTPException(status_code=400, detail="Could not calculate CGPA from the provided data")


# ==========================================
# ADMIN ENDPOINTS (Google Auth Protected)
# ==========================================

@app.on_event("startup")
async def on_startup():
    db.init_db()
    # Warm the shared browser in the background so the first login skips the ~7s Firefox launch
    asyncio.create_task(browser_pool.start())

@app.on_event("shutdown")
async def on_shutdown():
    await browser_pool.stop()

def valid_student_id(student_id: str) -> str:
    sid = student_id.strip()
    if not (3 <= len(sid) <= 24) or not all(c.isalnum() or c == "-" for c in sid):
        raise HTTPException(status_code=400, detail="Invalid student ID")
    return sid


async def get_current_admin(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authentication required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization header format")
    token = parts[1]
    admin = await verify_google_admin(token)
    if not admin:
        raise HTTPException(status_code=403, detail="Access denied. Authorized Google admin account required.")
    return admin

@app.get("/api/admin/me")
async def admin_me(admin: dict = Depends(get_current_admin)):
    """Verifies that the caller's Google credentials are valid and authorized."""
    return {"status": "ok", "admin": admin}

@app.get("/api/admin/students")
async def admin_list_students(admin: dict = Depends(get_current_admin)):
    """Returns overview list of all students cached in database."""
    students = db.list_all_students()
    return {"status": "ok", "total": len(students), "students": students}

@app.get("/api/admin/student/{student_id}")
async def admin_get_student_detail(student_id: str, admin: dict = Depends(get_current_admin)):
    """Returns full academic transcript for a specific student without needing their password."""
    student_id = valid_student_id(student_id)
    record = db.get_student(student_id)
    if not record:
        raise HTTPException(status_code=404, detail="Student record not found in database.")
    # Strip sensitive password hash before returning
    record.pop("password_hash", None)
    return {"status": "ok", "record": record}

@app.post("/api/admin/student/{student_id}/reset-cache")
async def admin_reset_student_cache(student_id: str, admin: dict = Depends(get_current_admin)):
    """Expires the 1-hour cache timer for a student, forcing fresh scrape on next login."""
    student_id = valid_student_id(student_id)
    success = db.reset_student_cache(student_id)
    return {"status": "ok", "message": f"Cache expired for {student_id}. Next login will scrape portal live."}

@app.delete("/api/admin/student/{student_id}")
async def admin_delete_student(student_id: str, admin: dict = Depends(get_current_admin)):
    """Permanently deletes student records and cached browser profile from database."""
    student_id = valid_student_id(student_id)
    db.delete_student(student_id)
    return {"status": "ok", "message": f"Student {student_id} permanently removed from database."}

class SettingsUpdateRequest(BaseModel):
    cache_ttl_minutes: Optional[int] = None
    public_search_enabled: Optional[bool] = None

@app.get("/api/admin/settings")
async def admin_get_settings(admin: dict = Depends(get_current_admin)):
    """Retrieves current global system settings."""
    settings = db.get_system_settings()
    return {"status": "ok", "settings": settings}

@app.post("/api/admin/settings")
async def admin_update_settings(req: SettingsUpdateRequest, admin: dict = Depends(get_current_admin)):
    """Updates global system settings (cache TTL and public search toggle)."""
    updates = {}
    if req.cache_ttl_minutes is not None:
        updates["cache_ttl_minutes"] = max(1, req.cache_ttl_minutes)
    if req.public_search_enabled is not None:
        updates["public_search_enabled"] = req.public_search_enabled
    db.update_system_settings(updates)
    return {"status": "ok", "settings": db.get_system_settings()}

class QueueRemoveRequest(BaseModel):
    id: str

@app.get("/api/admin/queue")
async def admin_get_queue(admin: dict = Depends(get_current_admin)):
    """Returns current live queue status, running scrapers, and waiting requests."""
    return {"status": "ok", "queue": {**queue_manager.get_status(), "browser": browser_pool.status()}}

@app.post("/api/admin/queue/remove")
async def admin_remove_queue(req: QueueRemoveRequest, admin: dict = Depends(get_current_admin)):
    """Removes and cancels a specific student ID or queue_id from the queue."""
    found = await queue_manager.remove(req.id)
    if not found:
        raise HTTPException(status_code=404, detail=f"Item '{req.id}' not found in active or waiting queue.")
    return {"status": "ok", "message": f"Successfully removed {req.id} from queue."}

@app.post("/api/admin/queue/clear")
async def admin_clear_queue(admin: dict = Depends(get_current_admin)):
    """Cancels and purges all waiting requests from the queue."""
    cancelled_count = await queue_manager.clear()
    return {"status": "ok", "message": f"Cleared {cancelled_count} waiting requests from queue.", "cancelled_count": cancelled_count}


if __name__ == "__main__":
    import uvicorn
    print("Starting DIU CGPA Calculator API...")
    print("Open http://localhost:8000 in your browser")
    print("Frontend should be running at http://localhost:3000")
    # Loopback by default: the Cloudflare tunnel on the same machine reaches it, the network
    # cannot (plain HTTP would expose student passwords). The Docker image sets HOST=0.0.0.0.
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))
