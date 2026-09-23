"""
DIU CGPA Calculator - FastAPI Backend
Provides API endpoint for the frontend to trigger portal scraping.
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime

# Add current directory to sys.path for local module imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
load_dotenv()

from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import db
from auth import verify_google_admin
from queue_manager import queue_manager
from scraper import DIUHeadlessScraper, dispatch_remote_click
from cgpa_calculator import calculate_overall_cgpa

# Request/Response models
class ScrapeRequest(BaseModel):
    student_id: str
    password: str

class CaptchaClickRequest(BaseModel):
    session_id: str
    x: float
    y: float

class StudentInfo(BaseModel):
    id: str = ""
    name: str = ""
    department: str = ""
    campus: str = ""
    email: str = ""

class CourseResult(BaseModel):
    name: str = ""
    code: str = ""
    credits: float = 0
    grade: str = ""
    grade_point: float = 0

class SemesterResult(BaseModel):
    name: str = ""
    gpa: float = 0
    credits: float = 0
    courses: list[CourseResult] = []

class ScrapeResponse(BaseModel):
    success: bool
    error: str = ""
    student: StudentInfo | None = None
    overall_cgpa: float = 0
    total_credits: float = 0
    total_completed_credits: float = 0
    semesters: list[SemesterResult] = []

# FastAPI app
app = FastAPI(
    title="DIU CGPA Calculator",
    description="Headless Scraper & CGPA Calculator for DIU",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "ok", "service": "DIU CGPA Calculator API (Headless)"}

@app.post("/api/scrape", response_model=ScrapeResponse)
async def scrape_results(request: ScrapeRequest, authorization: Optional[str] = Header(None)):
    if not request.student_id or not request.password:
        raise HTTPException(status_code=400, detail="Student ID and password are required")
    
    # Check if public searches are currently enabled
    settings = db.get_system_settings()
    if not settings.get("public_search_enabled", True):
        is_admin = False
        if authorization and authorization.startswith("Bearer "):
            admin_data = await verify_google_admin(authorization.split()[1])
            if admin_data:
                is_admin = True
        if not is_admin:
            return ScrapeResponse(
                success=False,
                error="Unable to connect to DIU Student Portal. Please try again later."
            )
    
    scraper = DIUHeadlessScraper()
    try:
        result = await scraper.scrape(
            student_id=request.student_id.strip(),
            password=request.password.strip()
        )
        
        if not result.get("success"):
            return ScrapeResponse(
                success=False,
                error=result.get("error", "Login or scraping failed.")
            )

        return ScrapeResponse(
            success=True,
            student=StudentInfo(**result.get("student", {})),
            overall_cgpa=result.get("overall_cgpa", 0.0),
            total_credits=result.get("total_credits", 0.0),
            total_completed_credits=result.get("total_completed_credits", 0.0),
            semesters=result.get("semesters", [])
        )
    except Exception as e:
        return ScrapeResponse(
            success=False,
            error=f"Error: {str(e)}"
        )

@app.post("/api/scrape-stream")
async def scrape_stream_endpoint(request: ScrapeRequest, authorization: Optional[str] = Header(None)):
    if not request.student_id or not request.password:
        raise HTTPException(status_code=400, detail="Student ID and password are required")
    
    # Check if public searches are currently enabled
    settings = db.get_system_settings()
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
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/captcha-click")
async def captcha_click_endpoint(req: CaptchaClickRequest):
    success = dispatch_remote_click(req.session_id, req.x, req.y)
    if not success:
        raise HTTPException(status_code=404, detail="Active browser session not found or timed out.")
    return {"status": "ok", "message": "Click dispatched to browser"}


@app.post("/api/calculate-cgpa")
async def calculate_cgpa_manual(data: dict):
    """
    Manually calculate CGPA from provided grade data.
    For users who want to enter their grades manually.
    """
    semesters = data.get("semesters", [])
    if not semesters:
        raise HTTPException(status_code=400, detail="No semester data provided")
    
    result = calculate_overall_cgpa(semesters)
    return result


# ==========================================
# ADMIN ENDPOINTS (Google Auth Protected)
# ==========================================

@app.on_event("startup")
async def on_startup():
    db.init_db()

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
    record = db.get_student(student_id)
    if not record:
        raise HTTPException(status_code=404, detail="Student record not found in database.")
    # Strip sensitive password hash before returning
    record.pop("password_hash", None)
    return {"status": "ok", "record": record}

@app.post("/api/admin/student/{student_id}/reset-cache")
async def admin_reset_student_cache(student_id: str, admin: dict = Depends(get_current_admin)):
    """Expires the 1-hour cache timer for a student, forcing fresh scrape on next login."""
    success = db.reset_student_cache(student_id)
    return {"status": "ok", "message": f"Cache expired for {student_id}. Next login will scrape portal live."}

@app.delete("/api/admin/student/{student_id}")
async def admin_delete_student(student_id: str, admin: dict = Depends(get_current_admin)):
    """Permanently deletes student records and cached browser profile from database."""
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

@app.post("/api/admin/scrape")
async def admin_direct_scrape(req: ScrapeRequest, admin: dict = Depends(get_current_admin)):
    """Admin-authenticated scrape tool that bypasses the public search kill switch."""
    if not req.student_id or not req.password:
        raise HTTPException(status_code=400, detail="Student ID and password are required")
    scraper = DIUHeadlessScraper()
    result = await scraper.scrape(student_id=req.student_id.strip(), password=req.password.strip())
    return result

class QueueRemoveRequest(BaseModel):
    id: str

@app.get("/api/admin/queue")
async def admin_get_queue(admin: dict = Depends(get_current_admin)):
    """Returns current live queue status, running scrapers, and waiting requests."""
    return {"status": "ok", "queue": queue_manager.get_status()}

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
    uvicorn.run(app, host="0.0.0.0", port=8000)
