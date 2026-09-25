"""
Pre-warmed Camoufox browsers for the DIU scraper.

Launching Firefox and opening its first page costs ~6s (much more when several launch at once),
so WARM_BROWSERS spares are prepared ahead of time -- browser launched on a fresh profile, blank
page open. A login takes a spare instantly and a replacement is warmed in the background.

Logins without a spare wait in FIFO order for the next browser to finish launching (including
spares already being warmed), and launches are capped by CPU count so a burst on a small VM
serves users one after another instead of making everyone wait for all launches at once.

Every login gets its own browser on a brand-new temporary profile, deleted afterwards:
- It must be a persistent (default) context: pages in extra new_context() windows report
  inconsistent window/screen geometry and Turnstile rejects the relayed checkbox clicks.
- Camoufox stalls page loads (Turnstile's api.js never arrives) once ~3 contexts share a browser.
- A used Firefox retains ~2.5x its fresh memory, so recycling beats reuse on a small VM.
- Each student gets a fresh fingerprint and a clean cookie jar (no Keycloak session leakage).
"""
import asyncio
import os
import shutil
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Optional

from camoufox import DefaultAddons
from camoufox.async_api import AsyncNewBrowser
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

from queue_manager import _meminfo_mb


def _default_warm_browsers() -> int:
    """
    WARM_BROWSERS env var if set, otherwise sized from RAM (~450 MB per idle spare).
    Below 1.5 GB there are none: an idle browser gets swapped out, and paging it back in during
    a login is slower than launching fresh (measured on a 887 MB Azure B2ats_v2).
    """
    env = os.getenv("WARM_BROWSERS")
    if env:
        return max(0, int(env))
    total = _meminfo_mb("MemTotal")
    if total is None:
        return 2
    if total < 1536:
        return 0
    if total < 2048:
        return 1
    if total < 4096:
        return 2
    return 3


WARM_BROWSERS = _default_warm_browsers()
# Simultaneous Firefox launches. Launching is CPU-heavy: on 2 cores, parallel launches all finish
# late, while serial ones hand the first user a browser after ~7s.
LAUNCH_CONCURRENCY = int(os.getenv("LAUNCH_CONCURRENCY", str(max(1, (os.cpu_count() or 2) // 4))))
# Free RAM needed to build a spare browser while a login is running (see _spare_build_allowed).
SPARE_BUILD_MIN_FREE_MB = int(os.getenv("SPARE_BUILD_MIN_FREE_MB", "700"))
# How long a login waits for a queued browser before launching its own as a fallback.
SPARE_WAIT_TIMEOUT = 60

# Throwaway profile dirs live here; leftovers from a crash are wiped at startup.
PROFILE_ROOT = os.path.abspath(os.getenv("BROWSER_PROFILE_ROOT", "./browser_profiles/tmp"))

# Lower RAM per browser. None of these are visible to page scripts.
LOW_MEMORY_FIREFOX_PREFS = {
    "fission.autostart": False,                    # no separate process per cross-origin iframe
    "dom.ipc.processCount": 1,                     # single content process
    "dom.ipc.processCount.webIsolated": 1,
    "dom.ipc.processPrelaunch.enabled": False,     # don't keep a spare process warm
    "browser.sessionhistory.max_total_viewers": 0, # no back/forward page cache
    "browser.cache.memory.capacity": 16384,        # 16 MB in-memory cache
    "media.memory_cache_max_size": 1024,
    "browser.sessionstore.max_tabs_undo": 0,
    "extensions.pocket.enabled": False,
    "media.rdd-process.enabled": False,            # no separate media-decoder process
    "extensions.webextensions.remote": False,      # no separate extensions process
}

# Camoufox bundles uBlock Origin by default; the login flow doesn't need it (~100 MB with the
# prefs above, measured on the server).
EXCLUDED_ADDONS = [DefaultAddons.UBO]


@dataclass
class _Warm:
    context: BrowserContext
    page: Optional[Page]
    profile_dir: str

    def alive(self) -> bool:
        return self.page is not None and not self.page.is_closed()


class BrowserPool:
    def __init__(self):
        self._pw_manager = None
        self._playwright: Optional[Playwright] = None
        self._pw_lock = asyncio.Lock()
        self._launch_limit = asyncio.Semaphore(LAUNCH_CONCURRENCY)
        self._ready: asyncio.Queue[_Warm] = asyncio.Queue()
        self._inflight = 0   # background launches that will land in _ready
        self._waiters = 0    # logins blocked on _ready.get()
        self._in_use = 0
        self._stopped = False

    async def start(self):
        """Wipes stale profiles and warms the spare(s) so the first login does not pay the startup cost."""
        self._stopped = False
        shutil.rmtree(PROFILE_ROOT, ignore_errors=True)
        os.makedirs(PROFILE_ROOT, exist_ok=True)
        print(f"[BROWSER] Warm spares: {WARM_BROWSERS}, parallel launches: {LAUNCH_CONCURRENCY}")
        self._schedule_launches()

    async def stop(self):
        self._stopped = True
        while not self._ready.empty():
            await self._close(self._ready.get_nowait())
        if self._pw_manager:
            try:
                await self._pw_manager.__aexit__(None, None, None)
            except Exception:
                pass
            self._pw_manager = None
            self._playwright = None

    def has_ready_browser(self) -> bool:
        return not self._ready.empty()

    async def _get_playwright(self) -> Playwright:
        async with self._pw_lock:
            if self._playwright is None:
                self._pw_manager = async_playwright()
                self._playwright = await self._pw_manager.__aenter__()
            return self._playwright

    async def _prepare(self) -> _Warm:
        """Launches a browser on a fresh temp profile and opens its blank page (the slow parts of a login)."""
        playwright = await self._get_playwright()
        async with self._launch_limit:
            t0 = time.monotonic()
            os.makedirs(PROFILE_ROOT, exist_ok=True)
            profile_dir = tempfile.mkdtemp(prefix="login_", dir=PROFILE_ROOT)
            try:
                # 'virtual' display (Xvfb) on Linux gives Turnstile a real compositor
                headless_mode = "virtual" if sys.platform.startswith("linux") else True
                context = await AsyncNewBrowser(
                    playwright,
                    headless=headless_mode,
                    humanize=True,
                    disable_coop=True,
                    i_know_what_im_doing=True,
                    locale="en-US",
                    persistent_context=True,
                    user_data_dir=profile_dir,
                    firefox_user_prefs=LOW_MEMORY_FIREFOX_PREFS,
                    exclude_addons=EXCLUDED_ADDONS,
                )
                try:
                    page = context.pages[0] if context.pages else await context.new_page()
                except BaseException:
                    await self._close(_Warm(context, None, profile_dir))
                    raise
            except BaseException:
                shutil.rmtree(profile_dir, ignore_errors=True)
                raise
            print(f"[BROWSER] Prepared browser in {time.monotonic() - t0:.1f}s")
            return _Warm(context, page, profile_dir)

    @staticmethod
    async def _close(warm: _Warm):
        try:
            await warm.context.close()
        except Exception:
            pass
        # Deleting the profile guarantees no student's Keycloak session survives into the next login
        await asyncio.to_thread(shutil.rmtree, warm.profile_dir, True)

    def _spare_build_allowed(self) -> bool:
        """
        Spares are built while nothing is running, or while logins are running only if RAM clearly
        fits a second browser. On a ~1 GB VM a spare built alongside a live login pushes both into
        swap, the login's browser crawls, and Turnstile rejects the user's (late) clicks.
        """
        if self._in_use == 0 and self._waiters == 0:
            return True
        available = _meminfo_mb("MemAvailable")
        return available is None or available >= SPARE_BUILD_MIN_FREE_MB

    def _schedule_launches(self):
        """Launches a browser for every waiting login, plus WARM_BROWSERS spares when RAM allows."""
        if self._stopped:
            return
        spares = WARM_BROWSERS if self._spare_build_allowed() else 0
        needed = spares + self._waiters - (self._ready.qsize() + self._inflight)
        for _ in range(max(0, needed)):
            self._inflight += 1
            asyncio.create_task(self._launch_into_ready())

    async def _launch_into_ready(self):
        try:
            warm = await self._prepare()
        except Exception as e:
            self._inflight -= 1
            print(f"[BROWSER] Background launch failed: {e}")
            return
        self._inflight -= 1
        if self._stopped:
            await self._close(warm)
        else:
            self._ready.put_nowait(warm)  # hands it to the longest-waiting login, if any

    async def _take_ready(self) -> Optional[_Warm]:
        """Next ready browser in FIFO order, or None if none arrives in time."""
        self._waiters += 1
        self._schedule_launches()
        try:
            while True:
                warm = await asyncio.wait_for(self._ready.get(), timeout=SPARE_WAIT_TIMEOUT)
                if warm.alive():
                    return warm
                await self._close(warm)
                self._schedule_launches()
        except asyncio.TimeoutError:
            return None
        finally:
            self._waiters -= 1

    @asynccontextmanager
    async def page(self):
        """Yields a ready blank Page in a dedicated fresh browser; the browser is closed afterwards."""
        warm = await self._take_ready()
        if warm is None:
            warm = await self._prepare()

        self._in_use += 1
        self._schedule_launches()  # replace the spare now, if RAM fits two browsers
        try:
            yield warm.page
        finally:
            await self._close(warm)
            self._in_use -= 1
            self._schedule_launches()  # otherwise replace it as soon as this login's RAM is freed

    def status(self) -> dict:
        return {
            "warm_spares": self._ready.qsize(),
            "in_use": self._in_use,
            "launching": self._inflight,
            "waiting_for_browser": self._waiters,
        }


browser_pool = BrowserPool()
