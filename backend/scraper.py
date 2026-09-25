"""
DIU Student Portal Scraper - Headless Streaming Scraper with Human-in-the-Loop Relay
Supports live streaming of progressive results (Server-Sent Events)
and interactive CAPTCHA relay when Cloudflare Turnstile requires user interaction.
"""
import asyncio
import os
import base64
import hashlib
import uuid
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
import httpx
import db
from browser_pool import browser_pool, WARM_BROWSERS
from queue_manager import queue_manager, QueueCancelledException, QueueFullException
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
SECURITY_CHECK_TIMEOUT = 120

# When set, the Turnstile widget is saved there every 10s while it is still verifying (diagnostics)
TURNSTILE_DEBUG_DIR = os.environ.get("TURNSTILE_DEBUG_DIR", "")

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

    async def scrape_stream(self, student_id: str, password: str):
        """Asynchronous generator yielding live progress, student profile, and each semester as loaded."""
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
            yield {"type": "error", "message": "A login for this Student ID is already in progress. Please wait for it to finish."}
            return
        _students_in_flight.add(clean_id)
        try:
            async for event in self._browser_scrape_stream(clean_id, student_id, password):
                yield event
        finally:
            _students_in_flight.discard(clean_id)

    async def _browser_scrape_stream(self, clean_id: str, student_id: str, password: str):
        """Live login via Camoufox + gateway fetch. Caller guarantees one run per student at a time."""
        auth_code = None
        session_id = str(uuid.uuid4())
        session_event = asyncio.Event()

        active_browser_sessions[session_id] = {
            "page": None,
            "event": session_event,
            "click_coords": None,
            "box": None,
        }

        code_event = asyncio.Event()

        yield {"type": "status", "step": "connect", "message": "Connecting to DIU Student Portal..."}

        queue_id = None
        try:
            async for q_event in queue_manager.acquire_stream(clean_id):
                if q_event.get("type") == "queue":
                    yield q_event
                elif q_event.get("type") == "acquired":
                    queue_id = q_event.get("queue_id")
                    break
        except QueueCancelledException:
            active_browser_sessions.pop(session_id, None)
            yield {"type": "error", "message": "Scrape request was cancelled by administrator."}
            return
        except QueueFullException:
            active_browser_sessions.pop(session_id, None)
            yield {"type": "error", "message": "The server is very busy right now. Please try again in a minute."}
            return
        except BaseException:
            active_browser_sessions.pop(session_id, None)
            raise

        try:
            # Step 1: Login in a dedicated pre-warmed Camoufox browser
            t_launch = time.monotonic()
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
                        check_url(page.url)
                        if auth_code:
                            break
                        if time.monotonic() > phase_deadline:
                            print(f"[TURNSTILE] {clean_id}: gave up - no checkbox/sign-in within {SECURITY_CHECK_TIMEOUT}s")
                            yield {"type": "error", "message": "DIU's security check is taking too long right now. Please try again in a minute."}
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
                            # Wait until Turnstile either passes on its own or settles on the interactive
                            # checkbox, then show it immediately. While "Verifying..." the spinner animates,
                            # so consecutive widget screenshots differ; identical shots mean it has settled.
                            # (The iframe HTML always contains the word "verifying", so it can't be used.)
                            settled_img = None
                            prev_img = None
                            identical = 0
                            wait_started = last_progress = time.monotonic()
                            while time.monotonic() < phase_deadline:
                                check_url(page.url)
                                if auth_code:
                                    break
                                if time.monotonic() - last_progress >= 10:
                                    last_progress = time.monotonic()
                                    print(f"[TURNSTILE] {clean_id}: still verifying ({last_progress - wait_started:.0f}s, identical frames={identical})")
                                    if TURNSTILE_DEBUG_DIR and prev_img:
                                        try:
                                            os.makedirs(TURNSTILE_DEBUG_DIR, exist_ok=True)
                                            with open(os.path.join(TURNSTILE_DEBUG_DIR, f"{session_id[:8]}_{last_progress - wait_started:03.0f}s.png"), "wb") as f:
                                                f.write(prev_img)
                                        except OSError:
                                            pass
                                token_val = await page.evaluate("""() => {
                                    const el = document.querySelector('[name="cf-turnstile-response"]');
                                    return el && el.value ? el.value : null;
                                }""")
                                if token_val:
                                    break
                                if await widget.count() == 0:
                                    break  # page moved on without needing the widget
                                t_step = time.monotonic()
                                try:
                                    wbox = await widget.bounding_box()
                                    t_box = time.monotonic() - t_step
                                    if wbox and wbox["width"] >= 200 and wbox["height"] >= 40:
                                        img = await widget.screenshot(timeout=10000)
                                        identical = identical + 1 if img == prev_img else 0
                                        prev_img = img
                                        if TURNSTILE_DEBUG_DIR:
                                            print(f"[TSDEBUG] {clean_id}: box {t_box:.1f}s shot {time.monotonic() - t_step - t_box:.1f}s hash {hashlib.md5(img).hexdigest()[:6]} identical={identical}")
                                        if identical >= 2:
                                            settled_img = img
                                            break
                                    elif TURNSTILE_DEBUG_DIR:
                                        print(f"[TSDEBUG] {clean_id}: box {t_box:.1f}s unusable box={wbox}")
                                except Exception as exc:
                                    # A slow/frozen browser (low-RAM server) times out a screenshot now and
                                    # then; keep the streak instead of resetting it, or it never settles.
                                    if TURNSTILE_DEBUG_DIR:
                                        print(f"[TSDEBUG] {clean_id}: {type(exc).__name__} after {time.monotonic() - t_step:.1f}s: {str(exc).splitlines()[0][:120]}")
                                await page.wait_for_timeout(300)

                            if auth_code:
                                break

                            if settled_img is not None and not token_val:
                                try:
                                    box = await widget.bounding_box()
                                    if box and box["width"] > 0 and box["height"] > 0:
                                        active_browser_sessions[session_id]["box"] = box
                                        img_bytes = settled_img
                                        img_b64 = "data:image/png;base64," + base64.b64encode(img_bytes).decode('utf-8')

                                        session_event.clear()
                                        active_browser_sessions[session_id]["click_coords"] = None

                                        print(f"[TURNSTILE] {clean_id}: interactive checkbox shown to user ({time.monotonic() - t_launch:.1f}s)")
                                        yield {
                                            "type": "challenge_required",
                                            "session_id": session_id,
                                            "image": img_b64,
                                            "box": box,
                                        }

                                        # Wait for user click from website modal
                                        try:
                                            t_shown = time.monotonic()
                                            await asyncio.wait_for(session_event.wait(), timeout=60.0)
                                            t_clicked = time.monotonic()
                                            phase_deadline += t_clicked - t_shown  # the user's thinking time doesn't count
                                            coords = active_browser_sessions[session_id].get("click_coords")
                                            if coords:
                                                click_x = float(coords["x"])
                                                click_y = float(coords["y"])
                                                await page.mouse.move(click_x, click_y, steps=10)
                                                await page.mouse.down()
                                                await page.wait_for_timeout(100)
                                                await page.mouse.up()

                                                # Also trigger click on cf_frame checkbox if accessible
                                                for f in page.frames:
                                                    if "challenges.cloudflare.com" in f.url:
                                                        try:
                                                            cb = f.locator('input[type="checkbox"], label, .ctp-checkbox-label, #challenge-stage').first
                                                            if await cb.count() > 0:
                                                                await cb.click(timeout=1500)
                                                        except Exception:
                                                            pass
                                                        break

                                                yield {"type": "status", "message": "Verification received. Processing..."}
                                                
                                                # Fast poll for resolution (every 300ms, up to 10s). A solved Turnstile
                                                # often navigates straight to the login form, which removes the token
                                                # input and destroys the JS context -- both mean success, not "pending".
                                                url_before_click = page.url
                                                solved = False
                                                for _ in range(30):
                                                    await page.wait_for_timeout(300)
                                                    check_url(page.url)
                                                    if auth_code or page.url != url_before_click:
                                                        solved = True
                                                        break
                                                    try:
                                                        token_val = await page.evaluate("""() => {
                                                            const el = document.querySelector('[name="cf-turnstile-response"]');
                                                            return el && el.value ? el.value : null;
                                                        }""")
                                                        widget_gone = await page.locator('#kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').count() == 0
                                                    except Exception:
                                                        # Execution context destroyed by navigation
                                                        solved = True
                                                        break
                                                    if token_val or widget_gone:
                                                        solved = True
                                                        break

                                                print(f"[TURNSTILE] {clean_id}: user clicked at {t_clicked - t_launch:.1f}s -> {'solved' if solved else 'still pending'} at {time.monotonic() - t_launch:.1f}s")
                                                if solved:
                                                    yield {"type": "challenge_solved"}
                                                else:
                                                    # The shown screenshot is stale now; close the modal until a fresh one is captured
                                                    yield {"type": "challenge_retry", "message": "Verification still pending. Loading a fresh check..."}
                                        except asyncio.TimeoutError:
                                            yield {"type": "error", "message": "Verification timed out. Please try again."}
                                            return
                                except Exception as exc:
                                    print(f"[TURNSTILE] Capture/click exception: {exc}")
                                    # Never leave the user staring at a stale checkbox; the loop re-captures if needed
                                    yield {"type": "challenge_retry", "message": "Checking verification..."}

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
                                yield {"type": "error", "message": err_txt.strip()}
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
                    yield {"type": "error", "message": "Could not reach the DIU login page. Please try again."}
                    return
        finally:
            active_browser_sessions.pop(session_id, None)
            if queue_id:
                await queue_manager.release(queue_id)


        if not auth_code:
            print(f"[LOGIN] {clean_id}: no auth code after login loop")
            yield {"type": "error", "message": "Invalid Student ID or Password. Please try again."}
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
                yield {"type": "error", "message": "Failed to exchange security token."}
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
