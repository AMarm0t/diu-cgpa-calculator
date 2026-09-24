"""
Queue and Concurrency Manager for DIU CGPA Calculator Scraper
Provides live queue observability, FIFO slot allocation, and administrative controls (remove/clear).
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any


class QueueCancelledException(Exception):
    """Raised when an enqueued or running scrape request is cancelled by an administrator."""
    pass


class QueueItem:
    def __init__(self, student_id: str):
        self.queue_id = f"qid_{uuid.uuid4().hex[:10]}"
        self.student_id = student_id.strip()
        self.status = "waiting"  # "waiting" | "running" | "cancelled" | "completed"
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
    def __init__(self, limit: int = 1):
        self.limit = limit
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
            self._waiting.append(item)

        try:
            last_reported_pos = None
            while True:
                async with self._condition:
                    # Check if this item was cancelled
                    if item.cancel_event.is_set():
                        if item in self._waiting:
                            self._waiting.remove(item)
                        raise QueueCancelledException(f"Request for {student_id} was cancelled by administrator.")

                    # If a worker slot is free and this item is next in line
                    if len(self._running) < self.limit and self._waiting and self._waiting[0] == item:
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
        except Exception:
            async with self._condition:
                if item in self._waiting:
                    self._waiting.remove(item)
            raise

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

            # Check running list
            for item in list(self._running):
                if item.queue_id == clean_id or item.student_id == clean_id:
                    item.status = "cancelled"
                    item.cancel_event.set()
                    self._running.remove(item)
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


# Global singleton instance (limit=1 ensures 1GB RAM VM never thrashes swap with concurrent browsers)
queue_manager = QueueManager(limit=1)
