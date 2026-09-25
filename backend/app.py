"""
DIU CGPA Calculator - FastAPI Backend
Provides API endpoint for the frontend to trigger portal scraping.
"""
import asyncio
import ipaddress
import json
import os
import socket
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
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
import db
from auth import verify_google_admin
from queue_manager import queue_manager
from scraper import DIUHeadlessScraper, dispatch_remote_click, request_leave
from browser_pool import browser_pool
from cgpa_calculator import calculate_overall_cgpa
import task_history

# Request models. Strict bounds keep junk out of the browser login, gateway URLs and the database.
class ScrapeRequest(BaseModel):
    # DIU student IDs come as xxx-xx-xxx or as one long number: digits, optionally in
    # dash-separated groups. Nothing else, so no code or encoded payloads fit.
    student_id: str = Field(..., min_length=5, max_length=24, pattern=r"^\s*[0-9]+(?:-[0-9]+){0,4}\s*$")
    # Any printable characters (real passwords use symbols), but bounded and no control characters
    password: str = Field(..., min_length=1, max_length=64, pattern=r"^[^\x00-\x1f\x7f]+$")

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

# A short name for this server, shown in the admin panel so each task/queue entry can be traced
# to the machine that handled it. Set NODE_NAME per server (e.g. azure-1, azure-2).
NODE_NAME = os.environ.get("NODE_NAME") or socket.gethostname()

# FastAPI app
# Interactive API docs (/docs, /redoc, /openapi.json) map every endpoint for an attacker;
# they are only served when ENABLE_API_DOCS=1 (local development).
_docs = os.environ.get("ENABLE_API_DOCS") == "1"
app = FastAPI(
    title="DIU CGPA Calculator",
    description="Headless Scraper & CGPA Calculator for DIU",
    version="2.0.0",
    docs_url="/docs" if _docs else None,
    redoc_url="/redoc" if _docs else None,
    openapi_url="/openapi.json" if _docs else None,
)

# Every request body here is a few hundred bytes; refuse anything larger before reading it.
MAX_BODY_BYTES = 8 * 1024


@app.middleware("http")
async def limit_body_and_harden(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        length = request.headers.get("content-length")
        if length is None and request.headers.get("transfer-encoding"):
            return JSONResponse({"detail": "Request body must declare its length."}, status_code=411)
        try:
            if length is not None and int(length) > MAX_BODY_BYTES:
                return JSONResponse({"detail": "Request body too large."}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        # Results and admin data are personal: never let browsers or proxies cache them
        response.headers["Cache-Control"] = "no-store"
    return response

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
# Limits. A whole campus can share one public IP, so per-IP limits only stop floods; password
# guessing is limited per student ID instead (and every attempt needs a person to pass the captcha).
LOGIN_RATE_LIMIT = int(os.environ.get("LOGIN_RATE_LIMIT_PER_MIN", "60"))         # per IP, per minute
STUDENT_ATTEMPT_LIMIT = int(os.environ.get("STUDENT_ATTEMPT_LIMIT", "10"))        # per student ID...
STUDENT_ATTEMPT_WINDOW = int(os.environ.get("STUDENT_ATTEMPT_WINDOW_S", "600"))   # ...per 10 minutes
CLICK_RATE_LIMIT = 300                                                           # per IP, per minute
LONGEST_LIMIT_WINDOW = max(60, STUDENT_ATTEMPT_WINDOW)
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


def _enforce_limit(bucket: str, key: str, limit: int, window_s: int, message: str):
    """Sliding-window counter: at most `limit` hits per `window_s` seconds for (bucket, key)."""
    now = time.monotonic()
    window = _rate_windows[(bucket, key)]
    while window and now - window[0] > window_s:
        window.popleft()
    if len(window) >= limit:
        raise HTTPException(status_code=429, detail=message)
    window.append(now)
    if len(_rate_windows) > 20000:  # bound memory under a wide flood
        for k in [k for k, w in _rate_windows.items() if not w or now - w[-1] > LONGEST_LIMIT_WINDOW]:
            del _rate_windows[k]


def enforce_rate_limit(request: Request, bucket: str, limit_per_min: int):
    """Per-IP flood guard. Students on campus Wi-Fi share one IP, so keep these generous."""
    _enforce_limit(bucket, client_ip(request), limit_per_min, 60,
                   "Too many requests from your network right now. Please try again in a minute.")

@app.get("/")
async def root():
    return {"status": "ok", "service": "DIU CGPA Calculator API (Headless)", "node": NODE_NAME}

@app.get("/api/capacity")
async def capacity(http_request: Request):
    """
    Lightweight, public, no-DB load snapshot the frontend polls to choose a server.
    free_slots > 0 means a login can start immediately; otherwise waiting is the queue length.
    """
    # Generous: waiting visitors poll it, and a whole campus can share one IP. It is only a
    # few in-memory counters, and a refused check would make the site think this server is down.
    enforce_rate_limit(http_request, "capacity", 600)
    q = queue_manager.get_status()
    b = browser_pool.status()
    active = q.get("active_count", 0)
    limit = q.get("limit", 1)
    return {
        "node": NODE_NAME,
        "limit": limit,
        "active": active,
        "free_slots": max(0, limit - active),
        "waiting": q.get("waiting_count", 0),
        "has_ready_browser": browser_pool.has_ready_browser(),
        "warm_spares": b.get("warm_spares", 0),
    }

@app.post("/api/scrape-stream")
async def scrape_stream_endpoint(request: ScrapeRequest, http_request: Request, authorization: Optional[str] = Header(None)):
    enforce_rate_limit(http_request, "login", LOGIN_RATE_LIMIT)
    _enforce_limit("student", request.student_id.strip(), STUDENT_ATTEMPT_LIMIT, STUDENT_ATTEMPT_WINDOW,
                   "Too many login attempts for this Student ID. Please wait a few minutes and try again.")

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
            async for item in scraper.scrape_stream(request.student_id.strip(), request.password.strip(), client_ip(http_request)):
                if item.get("type") == "heartbeat":
                    yield ": ping\n\n"  # SSE comment: keeps proxies from closing a quiet stream
                else:
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

@app.post("/api/leave")
async def leave_endpoint(http_request: Request):
    """
    The page reports that it left a login: moved to another server, or the tab was closed. Its place
    in line (or its running slot) is freed at once instead of when a write to it fails, which through
    Cloudflare takes ~15s. Sent with navigator.sendBeacon, so the JSON body arrives as text/plain:
    {"ticket": <the login's ticket>, "reason": "moved" | "left"}.
    """
    enforce_rate_limit(http_request, "leave", 300)
    try:
        body = json.loads((await http_request.body()) or b"{}")
        ticket = str(body.get("ticket", ""))[:64]
        reason = "moved" if body.get("reason") == "moved" else "left"
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Bad request")
    student_id = request_leave(ticket, reason)
    if student_id:
        await queue_manager.remove(student_id)
    return {"ok": bool(student_id)}

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
    cache_ttl_minutes: Optional[int] = Field(None, ge=1, le=10080)  # up to one week
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

@app.get("/api/admin/history")
async def admin_task_history(limit: int = 100, result: Optional[str] = None, admin: dict = Depends(get_current_admin)):
    """Recent lookups with their outcome (newest first). result= one outcome code or 'failures'."""
    if result is not None and result not in task_history.RESULTS and result != "failures":
        raise HTTPException(status_code=400, detail="Unknown result filter")
    tasks = await asyncio.to_thread(task_history.recent, limit, result)
    counts = await asyncio.to_thread(task_history.summary)
    return {"status": "ok", "node": NODE_NAME, "tasks": tasks, "counts": counts}


class QueueRemoveRequest(BaseModel):
    id: str

@app.get("/api/admin/queue")
async def admin_get_queue(admin: dict = Depends(get_current_admin)):
    """Returns current live queue status, running scrapers, and waiting requests."""
    return {"status": "ok", "node": NODE_NAME, "queue": {**queue_manager.get_status(), "browser": browser_pool.status()}}

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
    # loop="asyncio": under uvloop (uvicorn's Linux default) Playwright element screenshots stall
    # or time out, so the Turnstile checkbox was never detected as ready (reproduced on the server).
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")), loop="asyncio")
