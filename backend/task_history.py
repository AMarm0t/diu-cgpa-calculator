"""
Task history for the admin queue view: one row per lookup with its outcome and timings.

Stored in a small local SQLite file (survives restarts, never leaves the server) and capped
at MAX_ROWS. Never stores passwords.
"""
import os
import sqlite3
import threading
from typing import Any, Dict, List, Optional

HISTORY_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "task_history.db"))
MAX_ROWS = int(os.getenv("TASK_HISTORY_MAX_ROWS", "1000"))

# Outcome codes shown in the admin panel
RESULTS = (
    "success", "cached", "wrong_password", "timeout", "click_timeout", "stalled", "cancelled",
    "abandoned", "moved", "busy", "duplicate", "network", "portal_error", "failed",
)

_COLUMNS = (
    "task_id", "student_id", "client_ip", "source", "result", "stage", "message",
    "captcha_shown", "clicks", "semesters", "queue_wait_s", "duration_s", "started_at", "finished_at",
)
_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    conn = sqlite3.connect(HISTORY_PATH, timeout=5)
    try:
        os.chmod(HISTORY_PATH, 0o600)  # student IDs and visitor IPs: owner-only
    except OSError:
        pass
    conn.execute(
        """CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT, student_id TEXT, client_ip TEXT, source TEXT, result TEXT, stage TEXT,
            message TEXT, captcha_shown INTEGER, clicks INTEGER, semesters INTEGER,
            queue_wait_s REAL, duration_s REAL, started_at TEXT, finished_at TEXT
        )"""
    )
    return conn


def record(task: Dict[str, Any]) -> None:
    """Appends a finished task and trims the table to MAX_ROWS. Errors are logged, never raised."""
    row = [task.get(c) for c in _COLUMNS]
    try:
        with _lock, _connect() as conn:
            conn.execute(
                f"INSERT INTO task_history ({', '.join(_COLUMNS)}) VALUES ({', '.join('?' * len(_COLUMNS))})",
                row,
            )
            conn.execute(
                "DELETE FROM task_history WHERE id <= (SELECT MAX(id) FROM task_history) - ?", (MAX_ROWS,)
            )
    except Exception as e:
        print(f"[HISTORY] Could not record task: {e!r}")


def recent(limit: int = 100, result: Optional[str] = None) -> List[Dict[str, Any]]:
    """Newest first; optionally only one outcome (or 'failures' = everything but success/cached)."""
    limit = max(1, min(int(limit), MAX_ROWS))
    query = f"SELECT {', '.join(_COLUMNS)} FROM task_history"
    params: list = []
    if result == "failures":
        query += " WHERE result NOT IN ('success', 'cached')"
    elif result in RESULTS:
        query += " WHERE result = ?"
        params.append(result)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    try:
        with _lock, _connect() as conn:
            rows = conn.execute(query, params).fetchall()
    except Exception as e:
        print(f"[HISTORY] Could not read history: {e!r}")
        return []
    return [dict(zip(_COLUMNS, r)) for r in rows]


def summary() -> Dict[str, int]:
    """Counts per outcome over the stored history."""
    try:
        with _lock, _connect() as conn:
            return dict(conn.execute("SELECT result, COUNT(*) FROM task_history GROUP BY result").fetchall())
    except Exception:
        return {}
