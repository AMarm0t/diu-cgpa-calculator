"""
Database Access Layer for Student Results & Caching
Supports Supabase (Cloud PostgreSQL) with automatic fallback to local SQLite.
"""
import os
import json
import sqlite3
import hmac
import hashlib
import shutil
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Environment config
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
SECRET_SALT = os.environ.get("PASSWORD_SALT", "diu_cgpa_secure_salt_2026")

SQLITE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "results_cache.db"))

supabase_client = None

def get_supabase():
    global supabase_client
    if supabase_client is None and SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client
            supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        except Exception as e:
            print(f"[DB] Failed to connect to Supabase: {e}. Falling back to SQLite.")
            supabase_client = None
    return supabase_client

def hash_password(password: str) -> str:
    """Hashes a student password with HMAC-SHA256 for secure local offline verification."""
    return hmac.new(SECRET_SALT.encode(), password.encode(), hashlib.sha256).hexdigest()

def verify_password(password: str, stored_hash: str) -> bool:
    """Verifies candidate password against stored hash in constant time."""
    if not stored_hash:
        return False
    return hmac.compare_digest(hash_password(password), stored_hash)

def init_db():
    """Initializes local SQLite database if Supabase is not configured."""
    client = get_supabase()
    if client:
        print("[DB] Using Supabase Cloud Database.")
        return

    os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
    with sqlite3.connect(SQLITE_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS student_results (
                student_id TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                student_name TEXT,
                department TEXT,
                campus TEXT,
                overall_cgpa REAL,
                total_credits REAL,
                completed_credits REAL,
                results_json TEXT NOT NULL,
                last_fetched_at TIMESTAMP NOT NULL
            );
        """)
        conn.commit()
    print(f"[DB] Using Local SQLite Database at: {SQLITE_PATH}")

def get_student(student_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a student record by student_id."""
    clean_id = student_id.strip()
    client = get_supabase()
    if client:
        try:
            res = client.table("student_results").select("*").eq("student_id", clean_id).execute()
            if res.data and len(res.data) > 0:
                row = res.data[0]
                if isinstance(row.get("results_json"), str):
                    row["results_json"] = json.loads(row["results_json"])
                return row
            return None
        except Exception as e:
            print(f"[DB] Supabase error in get_student: {e}")

    # Fallback SQLite
    if not os.path.exists(SQLITE_PATH):
        init_db()

    with sqlite3.connect(SQLITE_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM student_results WHERE student_id = ?", (clean_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row)
            d["results_json"] = json.loads(d["results_json"])
            return d
    return None

def upsert_student(
    student_id: str,
    password: str,
    student_info: dict,
    overall_cgpa: float,
    total_credits: float,
    completed_credits: float,
    semesters: list,
    custom_payload: Optional[dict] = None
) -> bool:
    """Inserts or updates a student result record."""
    clean_id = student_id.strip()
    pwd_hash = hash_password(password)
    now_iso = datetime.now(timezone.utc).isoformat()
    if custom_payload is not None:
        results_payload = json.dumps(custom_payload)
    else:
        results_payload = json.dumps({
            "student": student_info,
            "overall_cgpa": overall_cgpa,
            "total_credits": total_credits,
            "total_completed_credits": completed_credits,
            "semesters": semesters
        })

    client = get_supabase()
    if client:
        try:
            record = {
                "student_id": clean_id,
                "password_hash": pwd_hash,
                "student_name": student_info.get("name", ""),
                "department": student_info.get("department", ""),
                "campus": student_info.get("campus", ""),
                "overall_cgpa": overall_cgpa,
                "total_credits": total_credits,
                "completed_credits": completed_credits,
                "results_json": results_payload,
                "last_fetched_at": now_iso
            }
            client.table("student_results").upsert(record).execute()
            return True
        except Exception as e:
            print(f"[DB] Supabase error in upsert_student: {e}")

    # Fallback SQLite
    if not os.path.exists(SQLITE_PATH):
        init_db()

    with sqlite3.connect(SQLITE_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO student_results (
                student_id, password_hash, student_name, department, campus,
                overall_cgpa, total_credits, completed_credits, results_json, last_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(student_id) DO UPDATE SET
                password_hash = excluded.password_hash,
                student_name = excluded.student_name,
                department = excluded.department,
                campus = excluded.campus,
                overall_cgpa = excluded.overall_cgpa,
                total_credits = excluded.total_credits,
                completed_credits = excluded.completed_credits,
                results_json = excluded.results_json,
                last_fetched_at = excluded.last_fetched_at
        """, (
            clean_id, pwd_hash, student_info.get("name", ""), student_info.get("department", ""),
            student_info.get("campus", ""), overall_cgpa, total_credits, completed_credits,
            results_payload, now_iso
        ))
        conn.commit()
        return True

def list_all_students() -> List[Dict[str, Any]]:
    """Returns a list of all stored students for admin overview (omits password_hash & full json)."""
    client = get_supabase()
    if client:
        try:
            res = client.table("student_results").select(
                "student_id, student_name, department, campus, overall_cgpa, total_credits, completed_credits, last_fetched_at"
            ).neq("student_id", "__SYSTEM_SETTINGS__").order("last_fetched_at", desc=True).execute()
            return res.data or []
        except Exception as e:
            print(f"[DB] Supabase error in list_all_students: {e}")

    if not os.path.exists(SQLITE_PATH):
        init_db()

    with sqlite3.connect(SQLITE_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            SELECT student_id, student_name, department, campus, overall_cgpa, total_credits, completed_credits, last_fetched_at 
            FROM student_results 
            WHERE student_id != '__SYSTEM_SETTINGS__'
            ORDER BY last_fetched_at DESC
        """)
        return [dict(r) for r in cursor.fetchall()]

def get_system_settings() -> Dict[str, Any]:
    """Retrieves system settings from database or returns defaults."""
    default_settings = {
        "cache_ttl_minutes": 60,
        "public_search_enabled": True
    }
    row = get_student("__SYSTEM_SETTINGS__")
    if row and isinstance(row.get("results_json"), dict):
        return {**default_settings, **row["results_json"]}
    return default_settings

def update_system_settings(new_settings: Dict[str, Any]) -> bool:
    """Updates system settings in database."""
    current = get_system_settings()
    current.update(new_settings)
    return upsert_student(
        student_id="__SYSTEM_SETTINGS__",
        password="system_settings_key",
        student_info={"name": "System Configuration"},
        overall_cgpa=0.0,
        total_credits=0.0,
        completed_credits=0.0,
        semesters=[],
        custom_payload=current
    )

def reset_student_cache(student_id: str) -> bool:
    """Sets last_fetched_at to 1970 so next student login re-scrapes the portal."""
    clean_id = student_id.strip()
    epoch_iso = "1970-01-01T00:00:00Z"
    client = get_supabase()
    if client:
        try:
            client.table("student_results").update({"last_fetched_at": epoch_iso}).eq("student_id", clean_id).execute()
            return True
        except Exception as e:
            print(f"[DB] Supabase error in reset_student_cache: {e}")

    if not os.path.exists(SQLITE_PATH):
        init_db()

    with sqlite3.connect(SQLITE_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE student_results SET last_fetched_at = ? WHERE student_id = ?", (epoch_iso, clean_id))
        conn.commit()
        return cursor.rowcount > 0

def delete_student(student_id: str) -> bool:
    """Deletes a student record and removes their browser profile directory."""
    clean_id = student_id.strip()
    client = get_supabase()
    if client:
        try:
            client.table("student_results").delete().eq("student_id", clean_id).execute()
        except Exception as e:
            print(f"[DB] Supabase error in delete_student: {e}")

    if os.path.exists(SQLITE_PATH):
        with sqlite3.connect(SQLITE_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM student_results WHERE student_id = ?", (clean_id,))
            conn.commit()

    # Remove persistent browser profile folder if it exists
    profile_dir = os.path.abspath(f"./browser_profiles/user_{clean_id.replace('-', '_')}")
    if os.path.exists(profile_dir):
        try:
            shutil.rmtree(profile_dir, ignore_errors=True)
        except Exception:
            pass

    return True
