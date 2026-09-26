"""
DIU Student Portal Scraper - Headless Streaming Scraper with Human-in-the-Loop Relay
Supports live streaming of progressive results (Server-Sent Events)
and interactive CAPTCHA relay when Cloudflare Turnstile requires user interaction.
"""
import asyncio
import os
import base64
import io
import hashlib
import uuid
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
import httpx
from PIL import Image
import db
from browser_pool import browser_pool, WARM_BROWSERS, SPARE_WAIT_TIMEOUT
from queue_manager import queue_manager, QueueCancelledException, QueueFullException, QueueTimeoutException
import task_history
from cgpa_calculator import calculate_overall_cgpa

LOGIN_URL = "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/auth?client_id=student-portal-ui&redirect_uri=https%3A%2F%2Fstudentportal.diu.edu.bd%2F&response_type=code&scope=openid+profile+email"
TOKEN_URL = "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/token"
GATEWAY_BASE = "https://gateway7.diu.edu.bd/api/student/portal"

# Registry for active interactive browser sessions
active_browser_sessions: dict[str, dict] = {}

# Student IDs with a login in flight. A second simultaneous login for the same ID would make
# Keycloak invalidate one of the two sessions, so it is rejected up front.
_students_in_flight: set[str] = set()

# Parallel gateway requests when scanning semester results
SEMESTER_FETCH_CONCURRENCY = 10

# Max seconds from login page load to sign-in, excluding time spent waiting for the user's click
SECURITY_CHECK_TIMEOUT = 90

# Seconds the user has to click once the live view of the security check is on screen. Most click
# within 5-10s; someone who walked away would otherwise hold one of the few slots.
CLICK_TIMEOUT = 60

# Hard cap on the whole browser phase (browser start -> signed in), whatever else happens. A normal
# login takes ~40s; each server runs only one or two at a time, so a stuck one must not hold its slot.
MAX_BROWSER_PHASE_SECONDS = 120

# Seconds of stream silence before a keep-alive comment is sent. Short, because a visitor who left
# (or moved to the other server) is only noticed when a write to them fails; until then they hold
# their place in line.
HEARTBEAT_SECONDS = 3

# The browser phase marks itself alive at least this often while healthy; past it the page is
# considered frozen and the login is aborted (see DIUHeadlessScraper._watched)
STALL_SECONDS = 40

# After the user's click Cloudflare accepts it within ~10s (max seen 10.1s); this long without progress
# means the page froze (seen a few times, always right after the click), so retry sooner than STALL_SECONDS
POST_CLICK_STALL_SECONDS = 20


# Live view stuck on the "Verifying..." spinner: nudge a repaint, then reload the page for a fresh check
SPINNER_NUDGE_AFTER = 12
SPINNER_RELOAD_AFTER = 25
MAX_WIDGET_RELOADS = 2

TOKEN_JS = """() => {
    const el = document.querySelector('[name="cf-turnstile-response"]');
    return el && el.value ? el.value : null;
}"""

# When set, extra per-step Turnstile diagnostics are logged
TURNSTILE_DEBUG_DIR = os.environ.get("TURNSTILE_DEBUG_DIR", "")

def looks_like_spinner(png: bytes) -> bool:
    """
    True if a Turnstile widget frame shows the green "Verifying..." spinner rather than the
    checkbox. Counts green pixels in the left 60px (spinner dots); on real frames captured on
    the server spinners had 57-66 and checkboxes 0.
    """
    try:
        im = Image.open(io.BytesIO(png)).convert("RGB")
    except Exception:
        return False
    w, h = im.size
    px = im.load()
    green = 0
    for x in range(min(60, w)):
        for y in range(h):
            r, g, b = px[x, y]
            if g > 100 and g > r + 40 and g > b + 15:
                green += 1
    return green > 15


_detached: set[asyncio.Future] = set()


def _detach(fut: asyncio.Future):
    """Keeps a background task referenced until it finishes, and swallows its outcome."""
    _detached.add(fut)

    def done(f: asyncio.Future):
        _detached.discard(f)
        if not f.cancelled():
            f.exception()  # retrieved, so asyncio doesn't log "exception was never retrieved"

    fut.add_done_callback(done)


def request_leave(session_id: str, reason: str) -> str | None:
    """
    Marks a login as left by its page ("moved" to another server, or "left": tab closed) and returns
    its student ID, so the caller can drop it from the line or stop it at once. None if unknown.
    """
    session = active_browser_sessions.get(session_id)
    if not session:
        return None
    session["leave"] = reason
    return session.get("student_id")


def dispatch_remote_click(session_id: str, x: float, y: float) -> bool:
    """Dispatches remote user click coordinates to the corresponding headless browser session."""
    session = active_browser_sessions.get(session_id)
    if session:
        session["click_coords"] = {"x": x, "y": y}
        session["event"].set()
        return True
    return False


class DIUHeadlessScraper:
    """Automates DIU Keycloak login headlessly and queries gateway7 with live streaming."""

    async def scrape_stream(self, student_id: str, password: str, client_ip: str = ""):
        """
        Asynchronous generator yielding live progress, student profile, and each semester as loaded.
        Every run is recorded in the task history (outcome, stage reached, timings; never the password).
        """
        started = time.monotonic()
        task = {
            "task_id": uuid.uuid4().hex[:12], "student_id": student_id.strip(), "client_ip": client_ip,
            "source": "live", "result": None, "stage": "connect", "message": "", "captcha_shown": 0,
            "clicks": 0, "semesters": 0, "queue_wait_s": 0.0,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "stall_deadline": None,  # set by the browser phase; see _watched
        }
        try:
            async for event in self._watched(self._scrape_stream_inner(student_id, password, task), task):
                etype = event.get("type")
                if etype == "status" and event.get("step"):
                    task["stage"] = event["step"]
                elif etype == "challenge_required":
                    task["captcha_shown"] = 1
                elif etype == "semester":
                    task["semesters"] += 1
                elif etype == "error":
                    task["result"] = event.get("code") or "failed"
                    detail = f" (while {event['detail']})" if event.get("detail") else ""
                    task["message"] = (str(event.get("message", "")) + detail)[:200]
                elif etype == "complete":
                    task["result"] = "cached" if task["source"] == "cache" else "success"
                    task["stage"] = "done"
                yield event
        except (GeneratorExit, asyncio.CancelledError):
            task["result"] = task["result"] or "abandoned"  # user closed the page / disconnected
            raise
        except Exception as e:
            task["result"] = "failed"
            task["message"] = f"{type(e).__name__}: {e}"[:200]
            raise
        finally:
            task["result"] = task["result"] or "abandoned"
            task["duration_s"] = round(time.monotonic() - started, 1)
            task["finished_at"] = datetime.now(timezone.utc).isoformat()
            task.pop("stall_deadline", None)
            task_history.record(task)  # local SQLite insert, a few ms; safe during generator close

    @staticmethod
    async def _watched(inner, task: dict):
        """
        Runs the login generator in its own task and relays its events, adding:
        - {"type": "heartbeat"} every HEARTBEAT_SECONDS of silence, so proxies (Cloudflare drops
          a response idle for ~100s) keep the stream open while the user thinks or waits in line;
        - a watchdog: once the browser phase stops showing signs of life (task["stall_deadline"]
          passes, e.g. a Playwright call hanging on a frozen page) the login is cancelled and a
          "stalled" error is sent, instead of leaving the user on a spinner.
        Its own task also keeps the login's cleanup (closing the browser, freeing the slot) whole
        when the visitor leaves: Starlette's cancellation would interrupt every await in it.
        """
        step = None
        try:
            while True:
                if step is None:
                    step = asyncio.ensure_future(inner.__anext__())
                done, _ = await asyncio.wait({step}, timeout=HEARTBEAT_SECONDS)
                if not done:
                    deadline = task.get("stall_deadline")
                    if deadline is not None and time.monotonic() > deadline:
                        doing = task.get("doing") or task["stage"]
                        print(f"[WATCHDOG] {task['student_id']}: browser stopped responding while {doing} - aborting")
                        yield {"type": "error", "code": "stalled", "detail": doing,
                               "message": "DIU's login page stopped responding. Please try again."}
                        return  # the finally cancels the login; its cleanup runs on in that task
                    yield {"type": "heartbeat"}
                    continue
                try:
                    event = step.result()
                except StopAsyncIteration:
                    step = None
                    return
                step = None
                yield event
        finally:
            if step is not None and not step.done():
                step.cancel()  # stalled, or the visitor left mid-step
                _detach(step)
            else:
                if step is not None:
                    _detach(step)  # finished but unread
                _detach(asyncio.ensure_future(inner.aclose()))  # suspended at a yield, or finished

    async def _scrape_stream_inner(self, student_id: str, password: str, task: dict):
        clean_id = student_id.strip()

        # Step 0: Transparent Database Cache Check (dynamic TTL from system settings)
        try:
            cached = await asyncio.to_thread(db.get_student, clean_id)
            if cached and await asyncio.to_thread(db.verify_password, password.strip(), cached.get("password_hash", "")):
                last_fetched = cached.get("last_fetched_at")
                is_fresh = False
                if last_fetched:
                    try:
                        clean_ts = str(last_fetched).replace("Z", "+00:00")
                        dt = datetime.fromisoformat(clean_ts)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        age = (datetime.now(timezone.utc) - dt).total_seconds()
                        settings = await asyncio.to_thread(db.get_system_settings)
                        ttl_minutes = settings.get("cache_ttl_minutes", 60)
                        ttl_seconds = max(60, int(ttl_minutes) * 60)
                        if age < ttl_seconds:
                            is_fresh = True
                    except Exception as err:
                        print(f"[CACHE] Timestamp parse error: {err}")

                if is_fresh:
                    results = cached.get("results_json", {})
                    if results and "student" in results:
                        task["source"] = "cache"
                        yield {"type": "status", "message": "Connecting to DIU Student Portal..."}
                        await asyncio.sleep(0.04)
                        yield {"type": "student", "data": results.get("student", {})}

                        seen_semesters = []
                        for sem in results.get("semesters", []):
                            await asyncio.sleep(0.02)
                            seen_semesters.append(sem)
                            stats = calculate_overall_cgpa(seen_semesters)

                            yield {
                                "type": "semester",
                                "data": sem,
                                "running_cgpa": stats["overall_cgpa"],
                                "total_credits": stats["total_credits"],
                                "completed_credits": stats["total_earned_credits"]
                            }

                        final_stats = calculate_overall_cgpa(results.get("semesters", []))
                        yield {
                            "type": "complete",
                            "overall_cgpa": final_stats["overall_cgpa"],
                            "total_credits": final_stats["total_credits"],
                            "total_completed_credits": final_stats["total_earned_credits"]
                        }
                        return
        except Exception as e:
            print(f"[CACHE] Cache check bypassed due to error: {e}")

        if clean_id in _students_in_flight:
            yield {"type": "error", "code": "duplicate", "message": "A login for this Student ID is already in progress. Please wait for it to finish."}
            return
        _students_in_flight.add(clean_id)
        try:
            async for event in self._browser_scrape_stream(clean_id, student_id, password, task):
                yield event
        finally:
            _students_in_flight.discard(clean_id)

    async def _browser_scrape_stream(self, clean_id: str, student_id: str, password: str, task: dict):
        """Live login via Camoufox + gateway fetch. Caller guarantees one run per student at a time."""
        auth_code = None
        session_id = str(uuid.uuid4())
        session_event = asyncio.Event()

        active_browser_sessions[session_id] = {
            "page": None,
            "event": session_event,
            "click_coords": None,
            "box": None,
            "student_id": clean_id,
            "leave": None,  # "moved" / "left" once the page reports it left (see request_leave)
        }

        def stopped_early() -> dict:
            """The error event for a login stopped from outside: the visitor left or moved, or an admin."""
            leave = active_browser_sessions.get(session_id, {}).get("leave")
            if leave == "moved":
                return {"type": "error", "code": "moved", "message": "Moved to another server."}
            if leave:
                return {"type": "error", "code": "abandoned", "message": "The visitor left."}
            print(f"[LOGIN] {clean_id}: cancelled by administrator")
            return {"type": "error", "code": "cancelled", "message": "This lookup was cancelled by an administrator."}

        code_event = asyncio.Event()

        # The page's private handle for this login: captcha clicks and /api/leave use it
        yield {"type": "ticket", "id": session_id}
        yield {"type": "status", "step": "connect", "message": "Connecting to DIU Student Portal..."}

        queue_id = None
        t_queued = time.monotonic()
        try:
            async for q_event in queue_manager.acquire_stream(clean_id):
                if q_event.get("type") == "queue":
                    yield q_event
                elif q_event.get("type") == "acquired":
                    queue_id = q_event.get("queue_id")
                    break
            task["queue_wait_s"] = round(time.monotonic() - t_queued, 1)
        except QueueCancelledException:
            event = stopped_early()
            active_browser_sessions.pop(session_id, None)
            yield event
            return
        except (QueueFullException, QueueTimeoutException):
            active_browser_sessions.pop(session_id, None)
            task["queue_wait_s"] = round(time.monotonic() - t_queued, 1)
            yield {"type": "error", "code": "busy", "message": "The server is very busy right now. Please try again in a minute."}
            return
        except BaseException:
            active_browser_sessions.pop(session_id, None)
            raise

        def alive(seconds: float = STALL_SECONDS, doing: str | None = None):
            """
            Marks the browser phase healthy; the watchdog aborts if the next mark comes later than this.
            `doing` names the step, so a freeze is logged with where it happened.
            """
            task["stall_deadline"] = time.monotonic() + seconds
            if doing:
                task["doing"] = doing

        try:
            # Step 1: Login in a dedicated pre-warmed Camoufox browser
            t_launch = time.monotonic()
            hard_deadline = t_launch + MAX_BROWSER_PHASE_SECONDS
            alive(SPARE_WAIT_TIMEOUT + 60, "starting the browser")  # may wait for one, then launch one
            if not browser_pool.has_ready_browser():
                msg = ("Starting a secure browser for you (~10s)..." if WARM_BROWSERS == 0
                       else "Busy moment - starting a secure browser for you (~10s)...")
                yield {"type": "status", "step": "connect", "message": msg}
            async with browser_pool.page() as page:
                print(f"[TIMING] {clean_id}: browser ready in {time.monotonic() - t_launch:.1f}s")
                active_browser_sessions[session_id]["page"] = page

                def check_url(url):
                    nonlocal auth_code
                    if 'code=' in url and 'studentportal' in url:
                        parsed = urlparse(url)
                        params = parse_qs(parsed.query)
                        if 'code' in params:
                            auth_code = params['code'][0]
                        elif '#' in url:
                            frag_params = parse_qs(parsed.fragment)
                            if 'code' in frag_params:
                                auth_code = frag_params['code'][0]
                    if auth_code:
                        code_event.set()

                async def wait_or_code(ms: int):
                    """Sleeps up to ms, returning early the moment the auth code redirect is seen."""
                    try:
                        await asyncio.wait_for(code_event.wait(), timeout=ms / 1000)
                    except asyncio.TimeoutError:
                        pass

                page.on("framenavigated", lambda frame: check_url(frame.url))

                try:
                    alive(130, "loading the DIU login page")  # bounded by its own timeouts
                    yield {"type": "status", "step": "verify", "message": "Passing security verification..."}
                    # Fast commit navigation prevents dropping connections on slow external assets
                    try:
                        await page.goto(LOGIN_URL, timeout=45000, wait_until="commit")
                    except Exception as nav_e:
                        print(f"[NAV] Page commit wait failed ({nav_e}), trying domcontentloaded...")
                        await page.goto(LOGIN_URL, timeout=45000, wait_until="domcontentloaded")

                    # Wait for either username input OR turnstile widget to be attached to DOM
                    try:
                        await page.wait_for_selector(
                            'input#username, #kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]',
                            timeout=30000
                        )
                    except Exception:
                        pass
                    print(f"[TIMING] {clean_id}: login page ready {time.monotonic() - t_launch:.1f}s after launch start")
                    # Hard limit for the whole security-check + sign-in phase, so a stuck Turnstile
                    # never leaves the user on a silent spinner (user click waits are excluded below).
                    phase_deadline = time.monotonic() + SECURITY_CHECK_TIMEOUT

                    # Loop through challenge and login steps
                    for attempt in range(45):
                        alive(doing="signing in")
                        check_url(page.url)
                        if auth_code:
                            break
                        if queue_manager.is_cancelled(queue_id):
                            yield stopped_early()
                            return
                        if time.monotonic() > phase_deadline or time.monotonic() > hard_deadline:
                            print(f"[TURNSTILE] {clean_id}: gave up - no sign-in within the time limit")
                            yield {"type": "error", "code": "timeout", "message": "DIU's security check is taking too long right now. Please try again in a minute."}
                            return

                        await wait_or_code(250)

                        # Check if Turnstile widget is present on the current page
                        widget = page.locator('#kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').first
                        has_turnstile = await widget.count() > 0

                        token_val = await page.evaluate("""() => {
                            const el = document.querySelector('[name="cf-turnstile-response"]');
                            return el && el.value ? el.value : null;
                        }""")

                        # If on standalone Turnstile step and solved, click continue
                        continue_btn = page.locator('#kc-turnstile-submit, input[type="submit"][name="continue"]').first
                        if await continue_btn.count() > 0 and token_val:
                            yield {"type": "status", "step": "login", "message": "Security check passed. Loading login..."}
                            try:
                                await continue_btn.click(no_wait_after=True, timeout=5000)
                            except Exception:
                                await page.evaluate("() => { const f = document.querySelector('#kc-turnstile-form'); if (f) f.submit(); }")
                            await wait_or_code(1000)
                            continue

                        # If Turnstile is active and not yet solved:
                        if has_turnstile and not token_val:
                            # Watch the widget frame by frame. While it shows the "Verifying..." spinner the
                            # user just sees a status line (Cloudflare often passes on its own); once the
                            # checkbox is on screen, frames are streamed to the popup until they click.
                            # Each frame is classified by pixels rather than waiting for the widget to
                            # "settle": on the Linux server painting stalls at random for ~15s.
                            session_event.clear()
                            active_browser_sessions[session_id]["click_coords"] = None
                            last_hash = None
                            shown_at = None
                            clicked = False
                            showing_spinner = True
                            last_change_at = time.monotonic()
                            nudged = False
                            reloads = 0
                            verifying_announced = False
                            while True:
                                alive(doing="showing the captcha")
                                now = time.monotonic()
                                # Until something is shown the security-check deadline applies; once the user
                                # can see the widget they get CLICK_TIMEOUT to act.
                                if (shown_at is None and now > phase_deadline) or (shown_at is not None and now - shown_at > CLICK_TIMEOUT):
                                    break
                                if now > hard_deadline or queue_manager.is_cancelled(queue_id):
                                    break
                                check_url(page.url)
                                if auth_code:
                                    break
                                try:
                                    token_val = await page.evaluate(TOKEN_JS)
                                    if token_val or await widget.count() == 0:
                                        break  # passed by itself, or the page moved on
                                    box = await widget.bounding_box()
                                    if box and box["width"] >= 200 and box["height"] >= 40:
                                        img = await page.screenshot(clip={k: box[k] for k in ("x", "y", "width", "height")}, timeout=8000)
                                        frame_hash = hashlib.md5(img).hexdigest()
                                        if frame_hash == last_hash and showing_spinner:
                                            stuck_for = time.monotonic() - last_change_at
                                            if stuck_for > SPINNER_NUDGE_AFTER and not nudged:
                                                # Painting on the server stalls at random; nudge a repaint
                                                nudged = True
                                                print(f"[TURNSTILE] {clean_id}: spinner frozen {stuck_for:.0f}s - nudging a repaint")
                                                try:
                                                    await page.mouse.move(box["x"] + box["width"] + 40, box["y"] + box["height"] + 40, steps=5)
                                                    await asyncio.wait_for(page.evaluate(
                                                        "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"), 3)
                                                except Exception:
                                                    pass
                                            elif stuck_for > SPINNER_RELOAD_AFTER and reloads < MAX_WIDGET_RELOADS:
                                                # Cloudflare itself sometimes hangs on "Verifying..."; a reload gets a fresh check
                                                reloads += 1
                                                print(f"[TURNSTILE] {clean_id}: spinner stuck {stuck_for:.0f}s - reloading the login page ({reloads}/{MAX_WIDGET_RELOADS})")
                                                yield {"type": "status", "step": "verify", "message": "Security check got stuck - refreshing it..."}
                                                alive(90, "reloading the stuck captcha")  # bounded themselves
                                                await page.reload(wait_until="commit", timeout=45000)
                                                await page.wait_for_selector('input#username, #kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]', timeout=30000)
                                                widget = page.locator('#kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').first
                                                last_hash, nudged = None, False
                                                last_change_at = time.monotonic()
                                                if shown_at is not None:
                                                    shown_at = time.monotonic()  # full click time after a refresh
                                                continue
                                        if session_event.is_set():
                                            clicked = True  # a click arrived meanwhile: no more frames
                                            break
                                        if frame_hash != last_hash:
                                            last_hash = frame_hash
                                            last_change_at = time.monotonic()
                                            was_spinner, showing_spinner = showing_spinner, looks_like_spinner(img)
                                            if was_spinner and not showing_spinner:
                                                print(f"[TURNSTILE] {clean_id}: checkbox visible ({time.monotonic() - t_launch:.1f}s)")
                                            if showing_spinner:
                                                # Only the checkbox needs the user; Cloudflare often passes on its own
                                                # after "Verifying...", in which case no popup is ever shown.
                                                if not verifying_announced:
                                                    verifying_announced = True
                                                    yield {"type": "status", "step": "verify", "message": "Cloudflare is verifying the connection..."}
                                            else:
                                                active_browser_sessions[session_id]["box"] = box
                                                if shown_at is None:
                                                    shown_at = time.monotonic()
                                                    print(f"[TURNSTILE] {clean_id}: checkbox shown to user ({shown_at - t_launch:.1f}s)")
                                                yield {
                                                    "type": "challenge_required",
                                                    "session_id": session_id,
                                                    "image": "data:image/png;base64," + base64.b64encode(img).decode("utf-8"),
                                                    "box": box,
                                                }
                                except Exception as exc:
                                    if TURNSTILE_DEBUG_DIR:
                                        print(f"[TSDEBUG] {clean_id}: {type(exc).__name__}: {str(exc).splitlines()[0][:120]}")
                                try:
                                    await asyncio.wait_for(session_event.wait(), timeout=1.5)
                                    clicked = True
                                    break
                                except asyncio.TimeoutError:
                                    pass

                            if auth_code:
                                break
                            if queue_manager.is_cancelled(queue_id):
                                yield stopped_early()
                                return
                            if time.monotonic() > hard_deadline:
                                print(f"[TURNSTILE] {clean_id}: gave up - browser phase over {MAX_BROWSER_PHASE_SECONDS}s")
                                yield {"type": "error", "code": "timeout", "message": "This took too long. Please try again."}
                                return

                            if not clicked:
                                if token_val and shown_at is not None:
                                    yield {"type": "challenge_solved"}  # passed without a click: close the modal
                                elif not token_val and shown_at is not None:
                                    print(f"[TURNSTILE] {clean_id}: no click within {CLICK_TIMEOUT}s")
                                    yield {"type": "error", "code": "click_timeout", "message": "Verification timed out. Please try again."}
                                    return
                                # otherwise nothing was shown before the deadline; the loop top reports it
                            else:
                                t_clicked = time.monotonic()
                                task["clicks"] = task.get("clicks", 0) + 1
                                phase_deadline += t_clicked - shown_at  # the user's thinking time doesn't count
                                coords = active_browser_sessions[session_id].get("click_coords")
                                if coords:
                                    alive(POST_CLICK_STALL_SECONDS, "clicking the captcha")
                                    try:
                                        click_x = float(coords["x"])
                                        click_y = float(coords["y"])
                                        # Step labels tell the watchdog (POST_CLICK_STALL_SECONDS) where a hang
                                        # happened; the durations show what normal looks like before any
                                        # per-step limit is set (a 6s guess cut off normal slow moves).
                                        t_input = time.monotonic()
                                        task["doing"] = "moving the mouse to the captcha"
                                        await page.mouse.move(click_x, click_y, steps=10)
                                        t_moved = time.monotonic()
                                        task["doing"] = "pressing the captcha checkbox"
                                        await page.mouse.down()
                                        await asyncio.sleep(0.1)
                                        task["doing"] = "releasing the captcha checkbox"
                                        await page.mouse.up()
                                        t_up = time.monotonic()
                                        print(f"[TURNSTILE] {clean_id}: click delivered - move {t_moved - t_input:.1f}s, press+release {t_up - t_moved:.1f}s")
                                    except Exception as exc:
                                        print(f"[TURNSTILE] {clean_id}: click failed: {exc!r}")

                                    yield {"type": "status", "message": "Verification received. Processing..."}

                                    # Poll for resolution (every 300ms, up to 10s). A solved Turnstile often
                                    # navigates straight to the login form, which removes the token input and
                                    # destroys the JS context -- both mean success, not "pending".
                                    url_before_click = page.url
                                    solved = False
                                    for _ in range(30):
                                        alive(POST_CLICK_STALL_SECONDS, "waiting for Cloudflare after the click")
                                        await page.wait_for_timeout(300)
                                        check_url(page.url)
                                        if auth_code or page.url != url_before_click:
                                            solved = True
                                            break
                                        try:
                                            task["doing"] = "reading the page after the click"
                                            token_val = await page.evaluate(TOKEN_JS)
                                            widget_gone = await page.locator('#kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').count() == 0
                                        except Exception:
                                            solved = True  # execution context destroyed by navigation
                                            break
                                        if token_val or widget_gone:
                                            solved = True
                                            break

                                    print(f"[TURNSTILE] {clean_id}: user clicked at {t_clicked - t_launch:.1f}s -> {'solved' if solved else 'still pending'} at {time.monotonic() - t_launch:.1f}s")
                                    if solved:
                                        yield {"type": "challenge_solved"}
                                    else:
                                        # Close the modal; the next round streams a fresh live view
                                        yield {"type": "challenge_retry", "message": "Verification still pending. Loading a fresh check..."}

                        # If on standalone Turnstile step and solved, click continue
                        continue_btn = page.locator('#kc-turnstile-submit, input[type="submit"][name="continue"]').first
                        if await continue_btn.count() > 0 and token_val:
                            yield {"type": "status", "step": "login", "message": "Security check passed. Loading login..."}
                            try:
                                await continue_btn.click(no_wait_after=True, timeout=5000)
                            except Exception:
                                await page.evaluate("() => { const f = document.querySelector('#kc-turnstile-form'); if (f) f.submit(); }")
                            await wait_or_code(1000)
                            continue

                        # Check for Keycloak login error message (e.g. wrong password)
                        error_el = page.locator('#input-error, .alert-error, .kc-feedback-text, #kc-feedback').first
                        if await error_el.count() > 0:
                            err_txt = await error_el.text_content()
                            if err_txt and any(w in err_txt.lower() for w in ["invalid", "incorrect", "failed"]):
                                print(f"[LOGIN] {clean_id}: portal rejected login: {err_txt.strip()}")
                                yield {"type": "error", "code": "wrong_password", "message": err_txt.strip()}
                                return

                        # Check if username field is present and ready
                        username_input = page.locator('#username').first
                        if await username_input.count() > 0:
                            current_val = await username_input.input_value()
                            if not current_val:
                                yield {"type": "status", "step": "login", "message": "Entering student credentials..."}
                                await username_input.fill(student_id)
                                password_input = page.locator('#password').first
                                if await password_input.count() > 0:
                                    await password_input.fill(password)
                                await page.wait_for_timeout(250)

                                submit_btn = page.locator('#kc-login, button[type="submit"]').first
                                if await submit_btn.count() > 0:
                                    yield {"type": "status", "step": "login", "message": "Submitting login..."}
                                    try:
                                        await submit_btn.click(no_wait_after=True, timeout=5000)
                                    except Exception:
                                        await page.evaluate("() => { const f = document.querySelector('#kc-form-login'); if (f) f.submit(); }")
                                    await wait_or_code(2000)
                except Exception as e:
                    print(f"[LOGIN] {clean_id}: navigation failed: {e!r}")
                    yield {"type": "error", "code": "network", "message": "Could not reach the DIU login page. Please try again."}
                    return
        finally:
            task["stall_deadline"] = None  # the gateway phase has its own request timeouts
            active_browser_sessions.pop(session_id, None)
            if queue_id:
                await queue_manager.release(queue_id)


        if not auth_code:
            print(f"[LOGIN] {clean_id}: no auth code after login loop")
            yield {"type": "error", "code": "failed", "message": "Invalid Student ID or Password. Please try again."}
            return

        print(f"[TIMING] {clean_id}: logged in {time.monotonic() - t_launch:.1f}s after start")
        yield {"type": "status", "step": "fetch", "message": "Access granted! Fetching academic profile..."}

        # Step 2: Exchange Auth Code for Access Token from Keycloak
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(TOKEN_URL, data={
                "grant_type": "authorization_code",
                "client_id": "student-portal-ui",
                "code": auth_code,
                "redirect_uri": "https://studentportal.diu.edu.bd/",
            })

            if token_resp.status_code != 200:
                yield {"type": "error", "code": "portal_error", "message": "Failed to exchange security token."}
                return

            token_data = token_resp.json()
            access_token = token_data.get("access_token")

            headers = {
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Origin": "https://studentportal.diu.edu.bd",
                "Referer": "https://studentportal.diu.edu.bd/",
            }

            # Step 3: Fetch Student Info & Metadata
            student_info = {
                "id": student_id,
                "name": "",
                "department": "CSE",
                "campus": "DSC",
                "email": ""
            }

            async def get_or_none(url, **kw):
                try:
                    r = await client.get(url, headers=kw.pop("hdrs", headers), **kw)
                    return r if r.status_code == 200 else None
                except Exception:
                    return None

            # Profile + semester catalog + history in parallel instead of 4 sequential round-trips
            account_resp, active_resp, sem_resp, graph_resp = await asyncio.gather(
                get_or_none(f"{GATEWAY_BASE}/account"),
                get_or_none(f"{GATEWAY_BASE}/active"),
                get_or_none(f"{GATEWAY_BASE}/semester"),
                get_or_none(f"{GATEWAY_BASE}/graph"),
            )

            if account_resp:
                acc = account_resp.json()
                student_info["name"] = f"{acc.get('firstName', '')} {acc.get('lastName', '')}".strip()
                student_info["department"] = acc.get('attributes', {}).get('department_code', ['CSE'])[0] if isinstance(acc.get('attributes', {}).get('department_code'), list) else 'CSE'
                student_info["campus"] = acc.get('attributes', {}).get('campus', ['DSC'])[0] if isinstance(acc.get('attributes', {}).get('campus'), list) else 'DSC'
                student_info["email"] = acc.get('email', '')

            # Fallback to Keycloak userinfo endpoint
            if not student_info["name"]:
                u_resp = await get_or_none(
                    "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/userinfo",
                    hdrs={"Authorization": f"Bearer {access_token}"}
                )
                if u_resp:
                    uinfo = u_resp.json()
                    student_info["name"] = uinfo.get("name", "").strip()
                    student_info["email"] = uinfo.get("email", "")

            # Stream student info right now so frontend immediately displays dashboard!
            yield {"type": "student", "data": student_info}

            # Step 4: Semesters Catalog & Active List
            active_semesters = {}
            if active_resp:
                for s in active_resp.json().get('data', []):
                    active_semesters[s.get('id')] = s.get('name', f"Semester {s.get('id')}")

            if sem_resp:
                d = sem_resp.json().get('data', {})
                if 'SEMESTER_ID' in d:
                    active_semesters[int(d['SEMESTER_ID'])] = d.get('SEMESTER_NAME', 'Enrolled Semester')

            graph_data = graph_resp.json().get('data', []) if graph_resp else []

            # Step 5: Scan every candidate semester concurrently, streaming results in semester order
            semesters_found = []

            candidate_ids = sorted(set(active_semesters.keys()) | set(range(60, 90)))
            fetch_limit = asyncio.Semaphore(SEMESTER_FETCH_CONCURRENCY)

            async def fetch_semester(sid):
                async with fetch_limit:
                    r = await get_or_none(f"{GATEWAY_BASE}/result/semester?studentId={student_id}&semesterId={sid}")
                try:
                    res = r.json() if r else None
                    if res and res.get("status") is not False and res.get("data"):
                        return self._parse_semester(res["data"], active_semesters.get(sid, f"Semester {sid}"))
                except Exception:
                    pass
                return None

            tasks = [asyncio.create_task(fetch_semester(sid)) for sid in candidate_ids]
            try:
                # Awaiting in order still streams progressively: later fetches run while earlier ones are awaited
                for task in tasks:
                    semester_item = await task
                    if not semester_item:
                        continue
                    semesters_found.append(semester_item)
                    stats = calculate_overall_cgpa(semesters_found)
                    yield {
                        "type": "semester",
                        "data": semester_item,
                        "running_cgpa": stats["overall_cgpa"],
                        "total_credits": stats["total_credits"],
                        "completed_credits": stats["total_earned_credits"]
                    }
            finally:
                for task in tasks:
                    task.cancel()

            # Step 6: If no course grades yet, check graph
            final_stats = calculate_overall_cgpa(semesters_found)
            final_overall_cgpa = final_stats["overall_cgpa"]
            final_total_credits = final_stats["total_credits"]
            final_completed_credits = final_stats["total_earned_credits"]

            if final_total_credits == 0 and graph_data:
                valid_gpas = [float(item['cgpa']) for item in graph_data if float(item.get('cgpa', 0)) > 0]
                if valid_gpas:
                    final_overall_cgpa = round(sum(valid_gpas) / len(valid_gpas), 2)
                    for item in graph_data:
                        if not any(s['name'] == item.get('semester') for s in semesters_found):
                            sem_fallback = {
                                "name": item.get('semester', ''),
                                "gpa": float(item.get('cgpa', 0)),
                                "credits": 0.0,
                                "courses": []
                            }
                            yield {
                                "type": "semester",
                                "data": sem_fallback,
                                "running_cgpa": final_overall_cgpa,
                                "total_credits": 0.0,
                                "completed_credits": 0.0
                            }

            # Persist fresh results to Database
            try:
                await asyncio.to_thread(
                    db.upsert_student,
                    student_id=student_id,
                    password=password,
                    student_info=student_info,
                    overall_cgpa=final_overall_cgpa,
                    total_credits=final_total_credits,
                    completed_credits=final_completed_credits,
                    semesters=semesters_found
                )
            except Exception as e:
                print(f"[DB] Error upserting student: {e}")

            print(f"[TIMING] {clean_id}: all results loaded {time.monotonic() - t_launch:.1f}s after start ({len(semesters_found)} semesters)")

            # Final completion signal
            yield {
                "type": "complete",
                "overall_cgpa": final_overall_cgpa,
                "total_credits": final_total_credits,
                "total_completed_credits": final_completed_credits
            }

    @staticmethod
    def _parse_semester(courses_raw: list, sem_name: str) -> dict:
        """Converts a gateway semester result payload into the dashboard's semester shape."""
        courses = []
        sem_weighted = 0.0
        sem_credits = 0.0

        for c in courses_raw:
            credit = float(c.get("courseCredit", 0.0) or 0.0)
            point = float(c.get("pointEquivalent", 0.0) or 0.0)
            grade = c.get("gradeLetter", "")

            courses.append({
                "code": c.get("courseCode", ""),
                "name": c.get("courseTitle", ""),
                "credits": credit,
                "grade": grade,
                "grade_point": point
            })

            if grade not in ["I", "W", "F", "R"] and point > 0:
                sem_weighted += credit * point
                sem_credits += credit
            elif grade == "F":
                sem_credits += credit

        sem_gpa = sem_weighted / sem_credits if sem_credits > 0 else 0.0
        return {
            "name": sem_name,
            "gpa": round(sem_gpa, 2),
            "credits": sem_credits,
            "courses": courses
        }

    async def scrape(self, student_id: str, password: str) -> dict:
        """Traditional non-streaming scrape fallback."""
        student_data = None
        semesters = []
        overall_cgpa = 0.0
        total_credits = 0.0
        completed_credits = 0.0

        async for event in self.scrape_stream(student_id, password):
            if event["type"] == "student":
                student_data = event["data"]
            elif event["type"] == "semester":
                semesters.append(event["data"])
            elif event["type"] == "complete":
                overall_cgpa = event["overall_cgpa"]
                total_credits = event["total_credits"]
                completed_credits = event["total_completed_credits"]
            elif event["type"] == "error":
                return {"success": False, "error": event["message"]}

        return {
            "success": True,
            "student": student_data,
            "overall_cgpa": overall_cgpa,
            "total_credits": total_credits,
            "total_completed_credits": completed_credits,
            "semesters": semesters
        }
