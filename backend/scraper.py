"""
DIU Student Portal Scraper - Headless Streaming Scraper with Human-in-the-Loop Relay
Supports live streaming of progressive results (Server-Sent Events)
and interactive CAPTCHA relay when Cloudflare Turnstile requires user interaction.
"""
import asyncio
import base64
import json
import os
import uuid
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
import httpx
from camoufox.async_api import AsyncCamoufox
import db
from queue_manager import queue_manager, QueueCancelledException

LOGIN_URL = "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/auth?client_id=student-portal-ui&redirect_uri=https%3A%2F%2Fstudentportal.diu.edu.bd%2F&response_type=code&scope=openid+profile+email"
TOKEN_URL = "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/token"
GATEWAY_BASE = "https://gateway7.diu.edu.bd/api/student/portal"

# Registry for active interactive browser sessions
active_browser_sessions: dict[str, dict] = {}

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
            cached = db.get_student(clean_id)
            if cached and db.verify_password(password.strip(), cached.get("password_hash", "")):
                last_fetched = cached.get("last_fetched_at")
                is_fresh = False
                if last_fetched:
                    try:
                        clean_ts = str(last_fetched).replace("Z", "+00:00")
                        dt = datetime.fromisoformat(clean_ts)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        age = (datetime.now(timezone.utc) - dt).total_seconds()
                        settings = db.get_system_settings()
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

                        running_points = 0.0
                        running_credits = 0.0
                        total_completed = 0.0

                        for sem in results.get("semesters", []):
                            await asyncio.sleep(0.02)
                            sem_earned = 0.0
                            for c in sem.get("courses", []):
                                cr = float(c.get("credits", 0.0) or 0.0)
                                gp = float(c.get("grade_point", 0.0) or 0.0)
                                gr = c.get("grade", "")
                                if gr not in ["I", "W", "R"] and gp > 0:
                                    running_credits += cr
                                    running_points += (cr * gp)
                                    sem_earned += cr
                                elif gr == "F":
                                    running_credits += cr
                            total_completed += sem_earned
                            running_cgpa = round(running_points / running_credits, 2) if running_credits > 0 else 0.0

                            yield {
                                "type": "semester",
                                "data": sem,
                                "running_cgpa": running_cgpa,
                                "total_credits": running_credits,
                                "completed_credits": total_completed
                            }

                        yield {
                            "type": "complete",
                            "overall_cgpa": results.get("overall_cgpa", 0.0),
                            "total_credits": results.get("total_credits", 0.0),
                            "total_completed_credits": results.get("total_completed_credits", 0.0)
                        }
                        return
        except Exception as e:
            print(f"[CACHE] Cache check bypassed due to error: {e}")

        auth_code = None
        session_id = str(uuid.uuid4())
        session_event = asyncio.Event()

        active_browser_sessions[session_id] = {
            "page": None,
            "event": session_event,
            "click_coords": None,
            "box": None,
        }

        # Persistent user data directory ensures cf_clearance cookies & trust score persist across runs
        profile_dir = os.path.abspath(f"./browser_profiles/user_{student_id.replace('-', '_')}")
        os.makedirs(profile_dir, exist_ok=True)

        # Proactively remove stale lock files left by previous aborted/crashed sessions
        for lock_name in [".parentlock", "lock", "parent.lock"]:
            lp = os.path.join(profile_dir, lock_name)
            try:
                if os.path.islink(lp) or os.path.exists(lp):
                    os.remove(lp)
            except Exception:
                pass

        yield {"type": "status", "message": "Connecting to DIU Student Portal..."}

        try:
            queue_id = await queue_manager.acquire(clean_id)
        except QueueCancelledException:
            yield {"type": "error", "message": "Scrape request was cancelled by administrator."}
            return

        try:
            # Step 1: Headless login with Camoufox (persistent profile + engine-level anti-detect + English locale)
            # Use 'virtual' display (Xvfb) on Linux for real window compositor and reliable Turnstile resolution
            headless_mode = "virtual" if sys.platform.startswith("linux") else True
            async with AsyncCamoufox(
                headless=headless_mode,
                humanize=True,
                disable_coop=True,
                i_know_what_im_doing=True,
                locale="en-US",
                persistent_context=True,
                user_data_dir=profile_dir,
            ) as context:
                page = context.pages[0] if context.pages else await context.new_page()
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

                page.on("framenavigated", lambda frame: check_url(frame.url))

                try:
                    yield {"type": "status", "message": "Passing security verification..."}
                    await page.goto(LOGIN_URL, timeout=35000, wait_until="domcontentloaded")

                    # Loop through challenge and login steps
                    for attempt in range(45):
                        check_url(page.url)
                        if auth_code:
                            break

                        await page.wait_for_timeout(400)

                        # Check if Turnstile widget is present on current page
                        widget = page.locator('#kc-turnstile-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').first
                        has_turnstile = await widget.count() > 0

                        token_val = await page.evaluate("""() => {
                            const el = document.querySelector('[name="cf-turnstile-response"]');
                            return el && el.value ? el.value : null;
                        }""")

                        # If Turnstile is active and not yet solved:
                        if has_turnstile and not token_val:
                            # Allow Camoufox 3-4s to pass Turnstile automatically in the background
                            for _ in range(6):
                                await page.wait_for_timeout(500)
                                token_val = await page.evaluate("""() => {
                                    const el = document.querySelector('[name="cf-turnstile-response"]');
                                    return el && el.value ? el.value : null;
                                }""")
                                if token_val:
                                    break

                            # If still not solved (interactive checkbox challenge), wait for widget to settle before screenshotting
                            if not token_val:
                                try:
                                    # Ensure widget has rendered dimensions
                                    for _ in range(10):
                                        box = await widget.bounding_box()
                                        if box and box["width"] >= 200 and box["height"] >= 40:
                                            break
                                        await page.wait_for_timeout(200)

                                    # Short delay to allow checkbox element to paint
                                    await page.wait_for_timeout(1000)
                                    box = await widget.bounding_box()
                                    if box and box["width"] > 0 and box["height"] > 0:
                                        active_browser_sessions[session_id]["box"] = box
                                        img_bytes = await widget.screenshot()
                                        img_b64 = "data:image/png;base64," + base64.b64encode(img_bytes).decode('utf-8')

                                        session_event.clear()
                                        active_browser_sessions[session_id]["click_coords"] = None

                                        yield {
                                            "type": "challenge_required",
                                            "session_id": session_id,
                                            "image": img_b64,
                                            "box": box,
                                        }

                                        # Wait for user click from website modal
                                        try:
                                            await asyncio.wait_for(session_event.wait(), timeout=60.0)
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
                                                            cb = f.locator('input[type="checkbox"], label, .ctp-checkbox-label').first
                                                            if await cb.count() > 0:
                                                                await cb.click(timeout=1500)
                                                        except Exception:
                                                            pass
                                                        break

                                                yield {"type": "status", "message": "Verification received. Processing..."}
                                                
                                                # Fast poll for token resolution (every 300ms, up to 10s)
                                                for _ in range(30):
                                                    await page.wait_for_timeout(300)
                                                    token_val = await page.evaluate("""() => {
                                                        const el = document.querySelector('[name="cf-turnstile-response"]');
                                                        return el && el.value ? el.value : null;
                                                    }""")
                                                    if token_val:
                                                        yield {"type": "challenge_solved"}
                                                        break

                                                if not token_val:
                                                    yield {"type": "challenge_retry", "message": "Verification still pending. Please click the checkbox again."}
                                        except asyncio.TimeoutError:
                                            yield {"type": "error", "message": "Verification timed out. Please try again."}
                                            return
                                except Exception:
                                    pass

                        if has_turnstile and not token_val:
                            # Keep waiting for Turnstile resolution; do not attempt credential entry yet
                            continue

                        # If on standalone Turnstile step and solved, click continue
                        continue_btn = page.locator('#kc-turnstile-submit, input[type="submit"][name="continue"]').first
                        if await continue_btn.count() > 0 and token_val:
                            yield {"type": "status", "message": "Security check passed. Loading login..."}
                            try:
                                await continue_btn.click(no_wait_after=True, timeout=5000)
                            except Exception:
                                await page.evaluate("() => { const f = document.querySelector('#kc-turnstile-form'); if (f) f.submit(); }")
                            await page.wait_for_timeout(1000)
                            continue

                        # Check for Keycloak login error message (e.g. wrong password)
                        error_el = page.locator('#input-error, .alert-error, .kc-feedback-text, #kc-feedback').first
                        if await error_el.count() > 0:
                            err_txt = await error_el.text_content()
                            if err_txt and any(w in err_txt.lower() for w in ["invalid", "incorrect", "failed"]):
                                yield {"type": "error", "message": err_txt.strip()}
                                return

                        # Check if username field is present and ready
                        username_input = page.locator('#username').first
                        if await username_input.count() > 0:
                            current_val = await username_input.input_value()
                            if not current_val:
                                yield {"type": "status", "message": "Entering student credentials..."}
                                await username_input.fill(student_id)
                                password_input = page.locator('#password').first
                                if await password_input.count() > 0:
                                    await password_input.fill(password)
                                await page.wait_for_timeout(1000)

                                submit_btn = page.locator('#kc-login, button[type="submit"]').first
                                if await submit_btn.count() > 0:
                                    yield {"type": "status", "message": "Submitting login..."}
                                    try:
                                        await submit_btn.click(no_wait_after=True, timeout=5000)
                                    except Exception:
                                        await page.evaluate("() => { const f = document.querySelector('#kc-form-login'); if (f) f.submit(); }")
                                    await page.wait_for_timeout(2000)
                except Exception as e:
                    yield {"type": "error", "message": f"Login navigation failed: {str(e)}"}
                    return
        finally:
            active_browser_sessions.pop(session_id, None)
            # Ensure lock files are cleaned up upon session termination
            if profile_dir:
                for lock_name in [".parentlock", "lock", "parent.lock"]:
                    lp = os.path.join(profile_dir, lock_name)
                    try:
                        if os.path.islink(lp) or os.path.exists(lp):
                            os.remove(lp)
                    except Exception:
                        pass
            await queue_manager.release(queue_id)

        if not auth_code:
            yield {"type": "error", "message": "Invalid Student ID or Password. Please try again."}
            return

        yield {"type": "status", "message": "Access granted! Fetching academic profile..."}

        # Step 2: Exchange Auth Code for Access Token from Keycloak
        async with httpx.AsyncClient(timeout=15, verify=False) as client:
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

            account_resp = await client.get(f"{GATEWAY_BASE}/account", headers=headers)
            if account_resp.status_code == 200:
                acc = account_resp.json()
                student_info["name"] = f"{acc.get('firstName', '')} {acc.get('lastName', '')}".strip()
                student_info["department"] = acc.get('attributes', {}).get('department_code', ['CSE'])[0] if isinstance(acc.get('attributes', {}).get('department_code'), list) else 'CSE'
                student_info["campus"] = acc.get('attributes', {}).get('campus', ['DSC'])[0] if isinstance(acc.get('attributes', {}).get('campus'), list) else 'DSC'
                student_info["email"] = acc.get('email', '')

            # Fallback to Keycloak userinfo endpoint
            if not student_info["name"]:
                try:
                    u_resp = await client.get(
                        "https://auth1.diu.edu.bd/realms/diu-student/protocol/openid-connect/userinfo",
                        headers={"Authorization": f"Bearer {access_token}"}
                    )
                    if u_resp.status_code == 200:
                        uinfo = u_resp.json()
                        student_info["name"] = uinfo.get("name", "").strip()
                        student_info["email"] = uinfo.get("email", "")
                except Exception:
                    pass

            # Stream student info right now so frontend immediately displays dashboard!
            yield {"type": "student", "data": student_info}

            # Step 4: Fetch Semesters Catalog & Active List
            active_semesters = {}
            active_resp = await client.get(f"{GATEWAY_BASE}/active", headers=headers)
            if active_resp.status_code == 200:
                for s in active_resp.json().get('data', []):
                    active_semesters[s.get('id')] = s.get('name', f"Semester {s.get('id')}")

            sem_resp = await client.get(f"{GATEWAY_BASE}/semester", headers=headers)
            if sem_resp.status_code == 200:
                d = sem_resp.json().get('data', {})
                if 'SEMESTER_ID' in d:
                    active_semesters[int(d['SEMESTER_ID'])] = d.get('SEMESTER_NAME', 'Enrolled Semester')

            # Fetch graph data to see student's semester history
            graph_data = []
            graph_resp = await client.get(f"{GATEWAY_BASE}/graph", headers=headers)
            if graph_resp.status_code == 200:
                graph_data = graph_resp.json().get('data', [])

            # Step 5: Progressively Scan & Stream Each Semester Result
            semesters_found = []
            grand_total_credits = 0.0
            grand_total_weighted = 0.0
            total_earned_credits = 0.0

            candidate_ids = set(active_semesters.keys())
            candidate_ids.update(range(60, 90))

            for sid in sorted(candidate_ids):
                url = f"{GATEWAY_BASE}/result/semester?studentId={student_id}&semesterId={sid}"
                try:
                    r = await client.get(url, headers=headers)
                    if r.status_code == 200:
                        res = r.json()
                        if res.get("status") is not False and res.get("data"):
                            courses_raw = res.get("data", [])
                            courses = []
                            sem_weighted = 0.0
                            sem_credits = 0.0
                            sem_earned = 0.0

                            for c in courses_raw:
                                credit = float(c.get("courseCredit", 0.0) or 0.0)
                                point = float(c.get("pointEquivalent", 0.0) or 0.0)
                                grade = c.get("gradeLetter", "")
                                title = c.get("courseTitle", "")
                                code = c.get("courseCode", "")

                                courses.append({
                                    "code": code,
                                    "name": title,
                                    "credits": credit,
                                    "grade": grade,
                                    "grade_point": point
                                })

                                if grade not in ["I", "W", "F", "R"] and point > 0:
                                    sem_weighted += credit * point
                                    sem_credits += credit
                                    sem_earned += credit
                                elif grade == "F":
                                    sem_credits += credit

                            sem_gpa = sem_weighted / sem_credits if sem_credits > 0 else 0.0
                            sem_name = active_semesters.get(sid, f"Semester {sid}")

                            grand_total_weighted += sem_weighted
                            grand_total_credits += sem_credits
                            total_earned_credits += sem_earned

                            running_cgpa = round(grand_total_weighted / grand_total_credits, 2) if grand_total_credits > 0 else 0.0

                            semester_item = {
                                "name": sem_name,
                                "gpa": round(sem_gpa, 2),
                                "credits": sem_credits,
                                "courses": courses
                            }
                            semesters_found.append(semester_item)

                            # Stream this semester immediately to frontend!
                            yield {
                                "type": "semester",
                                "data": semester_item,
                                "running_cgpa": running_cgpa,
                                "total_credits": grand_total_credits,
                                "completed_credits": total_earned_credits
                            }
                except Exception:
                    pass

            # Step 6: If no course grades yet, check graph
            final_overall_cgpa = 0.0
            if grand_total_credits > 0:
                final_overall_cgpa = round(grand_total_weighted / grand_total_credits, 2)
            elif graph_data:
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
                db.upsert_student(
                    student_id=student_id,
                    password=password,
                    student_info=student_info,
                    overall_cgpa=final_overall_cgpa,
                    total_credits=grand_total_credits,
                    completed_credits=total_earned_credits,
                    semesters=semesters_found
                )
            except Exception as e:
                print(f"[DB] Error upserting student: {e}")

            # Final completion signal
            yield {
                "type": "complete",
                "overall_cgpa": final_overall_cgpa,
                "total_credits": grand_total_credits,
                "total_completed_credits": total_earned_credits
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
