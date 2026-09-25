"""
Queue and Concurrency Manager for DIU CGPA Calculator Scraper
Provides live queue observability, FIFO slot allocation, and administrative controls (remove/clear).
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any


# Rough RAM cost of one login (a pooled Camoufox browser with the login page open), in MB.
BROWSER_MB = int(os.getenv("BROWSER_MB", "280"))
# RAM kept free for the OS, FastAPI, Docker and the warm spare browser, in MB.
RESERVED_MB = int(os.getenv("RESERVED_MB", "350"))
# Longest allowed waiting line. Beyond this, new requests are turned away instead of each holding
# an open connection in memory (flood protection).
MAX_WAITING = int(os.getenv("MAX_QUEUE_WAITING", "30"))
# Longest time a request may wait in line before it is turned away as "server busy".
MAX_QUEUE_WAIT_SECONDS = int(os.getenv("MAX_QUEUE_WAIT_SECONDS", "180"))


def _meminfo_mb(field: str) -> Optional[int]:
    """Reads a field (e.g. MemTotal, MemAvailable) from /proc/meminfo. Returns None off Linux."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith(field + ":"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


def _default_limit() -> int:
    """MAX_CONCURRENT_SCRAPES env var if set, otherwise sized from total RAM (1..10)."""
    env = os.getenv("MAX_CONCURRENT_SCRAPES")
    if env:
        return max(1, int(env))
    total = _meminfo_mb("MemTotal")
    if total is None:
        return 4
    return max(1, min(10, (total - RESERVED_MB) // BROWSER_MB))


class QueueCancelledException(Exception):
    """Raised when an enqueued or running scrape request is cancelled by an administrator."""
    pass


class QueueFullException(Exception):
    """Raised when the waiting line is already at MAX_WAITING."""
    pass


class QueueTimeoutException(Exception):
    """Raised when a request waited longer than MAX_QUEUE_WAIT_SECONDS for a slot."""
    pass


class QueueItem:
    def __init__(self, student_id: str):
        self.queue_id = f"qid_{uuid.uuid4().hex[:10]}"
        self.student_id = student_id.strip()
        self.status = "waiting"  # "waiting" | "running" | "cancelling" | "cancelled"
        self.queued_at = datetime.now(timezone.utc).isoformat()
        self.started_at: Optional[str] = None
        self.cancel_event = asyncio.Event()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "queue_id": self.queue_id,
            "student_id": self.student_id,
            "status": self.status,
            "queued_at": self.queued_at,
            "started_at": self.started_at,
        }


class QueueManager:
    def __init__(self, limit: Optional[int] = None):
        self.limit = limit or _default_limit()
        self._running: List[QueueItem] = []
        self._waiting: List[QueueItem] = []
        self._lock = asyncio.Lock()
        self._condition = asyncio.Condition(self._lock)

    async def acquire_stream(self, student_id: str):
        """
        Enqueues a scrape request.
        Yields queue position events while waiting in line,
        then yields {'type': 'acquired', 'queue_id': queue_id} once a worker slot is allocated.
        Raises QueueCancelledException if cancelled by an administrator while waiting.
        """
        item = QueueItem(student_id)

        async with self._condition:
            if len(self._waiting) >= MAX_WAITING:
                raise QueueFullException("Too many requests are waiting.")
            self._waiting.append(item)

        try:
            last_reported_pos = None
            wait_deadline = asyncio.get_running_loop().time() + MAX_QUEUE_WAIT_SECONDS
            while True:
                if asyncio.get_running_loop().time() > wait_deadline:
                    raise QueueTimeoutException(f"Waited more than {MAX_QUEUE_WAIT_SECONDS}s for a slot.")
                async with self._condition:
                    # Check if this item was cancelled
                    if item.cancel_event.is_set():
                        if item in self._waiting:
                            self._waiting.remove(item)
                        raise QueueCancelledException(f"Request for {student_id} was cancelled by administrator.")

                    # If a worker slot is free and this item is next in line
                    if len(self._running) < self.limit and self._waiting and self._waiting[0] == item and self._has_memory_for_browser():
                        self._waiting.pop(0)
                        item.status = "running"
                        item.started_at = datetime.now(timezone.utc).isoformat()
                        self._running.append(item)
                        yield {"type": "acquired", "queue_id": item.queue_id}
                        return

                    # Compute current position in line (1-indexed)
                    pos = (self._waiting.index(item) + 1) if item in self._waiting else 1

                # If position changed, inform the client
                if pos != last_reported_pos:
                    last_reported_pos = pos
                    yield {
                        "type": "queue",
                        "position": pos,
                        "message": f"Server busy. Position #{pos} in queue. Scraping starts automatically..."
                    }

                # Wait for worker release or cancellation
                try:
                    async with self._condition:
                        await asyncio.wait_for(self._condition.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
        except BaseException:
            # BaseException: client disconnects surface as CancelledError/GeneratorExit, and a
            # waiting item left behind at the head of the line would block the queue forever.
            # No await here (it may be re-cancelled); other waiters re-check every second anyway.
            if item in self._waiting:
                self._waiting.remove(item)
            raise

    def _has_memory_for_browser(self) -> bool:
        """
        Admission control: only launch another browser if the machine actually has RAM for it.
        The first browser is always allowed so a lone request can never deadlock.
        """
        if not self._running:
            return True
        available = _meminfo_mb("MemAvailable")
        if available is None:
            return True
        return available - BROWSER_MB >= 150

    def is_cancelled(self, queue_id: Optional[str]) -> bool:
        """True once an administrator cancelled this running task (the scraper polls this)."""
        return any(item.queue_id == queue_id and item.cancel_event.is_set() for item in self._running)

    async def acquire(self, student_id: str) -> str:
        """
        Enqueues a scrape request synchronously. Suspends coroutine until a worker slot is available.
        Raises QueueCancelledException if cancelled by an administrator while waiting.
        Returns queue_id.
        """
        async for event in self.acquire_stream(student_id):
            if event.get("type") == "acquired":
                return event["queue_id"]
        raise RuntimeError("Failed to acquire worker slot from queue.")

    async def release(self, queue_id: str):
        """Releases the worker slot occupied by queue_id and notifies the next waiting item."""
        async with self._condition:
            self._running = [item for item in self._running if item.queue_id != queue_id]
            self._condition.notify_all()

    async def remove(self, identifier: str) -> bool:
        """
        Removes an item by queue_id or student_id.
        Cancels it if it is waiting in line or actively running.
        Returns True if found and cancelled.
        """
        async with self._condition:
            clean_id = identifier.strip()
            found = False

            # Check waiting queue
            for item in list(self._waiting):
                if item.queue_id == clean_id or item.student_id == clean_id:
                    item.status = "cancelled"
                    item.cancel_event.set()
                    self._waiting.remove(item)
                    found = True

            # Running tasks are only flagged: the scraper sees the flag, stops its browser and then
            # releases the slot itself. Removing them here would free the slot while the browser
            # still runs, letting a second browser start on a small server.
            for item in self._running:
                if (item.queue_id == clean_id or item.student_id == clean_id) and not item.cancel_event.is_set():
                    item.status = "cancelling"
                    item.cancel_event.set()
                    found = True

            if found:
                self._condition.notify_all()
            return found

    async def clear(self) -> int:
        """
        Cancels all waiting requests in the queue.
        Returns the number of cancelled requests.
        """
        async with self._condition:
            count = len(self._waiting)
            for item in self._waiting:
                item.status = "cancelled"
                item.cancel_event.set()
            self._waiting.clear()
            self._condition.notify_all()
            return count

    def get_status(self) -> Dict[str, Any]:
        """Returns snapshot of current queue state."""
        return {
            "limit": self.limit,
            "active_count": len(self._running),
            "waiting_count": len(self._waiting),
            "running": [item.to_dict() for item in self._running],
            "waiting": [item.to_dict() for item in self._waiting],
        }


# Global singleton instance. Limit is sized from RAM (override with MAX_CONCURRENT_SCRAPES);
# each extra slot is additionally gated on live MemAvailable so browsers never push the VM into swap.
queue_manager = QueueManager()
print(f"[QUEUE] Max concurrent scrapes: {queue_manager.limit}")
