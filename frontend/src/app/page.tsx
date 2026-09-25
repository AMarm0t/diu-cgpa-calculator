"use client";

import { useState, useEffect, useRef } from "react";
import { 
  ChevronDown, 
  ChevronUp, 
  AlertCircle, 
  Loader2, 
  CheckCircle2, 
  ShieldCheck,
  Sun,
  Moon,
  Eye,
  EyeOff
} from "lucide-react";

interface Course {
  name: string;
  code: string;
  credits: number;
  grade: string;
  grade_point: number;
}

interface Semester {
  name: string;
  gpa: number;
  credits: number;
  courses: Course[];
}

interface StudentData {
  student: {
    name: string;
    id: string;
    department: string;
    campus: string;
    email?: string;
  };
  overall_cgpa: number;
  total_credits: number;
  total_completed_credits: number;
  semesters: Semester[];
}

interface ChallengeData {
  sessionId: string;
  image: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// One or more backend servers, comma-separated in NEXT_PUBLIC_API_URLS. Falls back to the single
// NEXT_PUBLIC_API_URL. The first entry is the primary; later ones absorb overflow and act as failover.
const API_BASES = (
  process.env.NEXT_PUBLIC_API_URLS ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://api.resultscraper.app"
)
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const API_BASE = API_BASES[0];

// The server sends a keep-alive at least every 10s during a login; this long without a single
// byte means the connection is dead (network drop, proxy timeout) and waiting longer is pointless.
const STREAM_IDLE_LIMIT_MS = 45000;

// Picks which server should handle a new login. Prefers a server with a free slot (a login can
// start at once), choosing a warm one and the primary on ties; otherwise the shortest queue.
// A server that doesn't answer its capacity check within 2.5s is treated as down and skipped; once
// any server has reported a free slot the others get only 300ms more, so a hung server doesn't
// delay logins on a healthy one.
// `avoid` (a server whose browser just froze) is only chosen when it is clearly the better option.
async function pickServer(avoid?: string): Promise<string> {
  if (API_BASES.length === 1) return API_BASES[0];
  type Probe = { base: string; index: number; free: number; waiting: number; ready: boolean };
  const answers: (Probe | null)[] = API_BASES.map(() => null);
  let onFree: () => void = () => {};
  const someoneFree = new Promise<void>((resolve) => (onFree = resolve));
  const probes = API_BASES.map(async (base, index) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch(`${base}/api/capacity`, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      answers[index] = {
        base,
        index,
        free: Number(d.free_slots ?? 0),
        waiting: Number(d.waiting ?? 999),
        ready: Boolean(d.has_ready_browser),
      };
      if (answers[index]!.free > 0) onFree();
    } catch {
      // unreachable or too slow: treated as down
    } finally {
      clearTimeout(timer);
    }
  });
  await Promise.race([
    Promise.all(probes),
    someoneFree.then(() => new Promise((r) => setTimeout(r, 300))),
  ]);
  const up = answers.filter((p): p is Probe => p !== null);
  if (up.length === 0) return API_BASES[0]; // none answered; the request path will try failover
  const free = up.filter((s) => s.free > 0);
  if (free.length > 0) {
    free.sort((a, b) =>
      Number(a.base === avoid) - Number(b.base === avoid) || Number(b.ready) - Number(a.ready) || a.index - b.index
    );
    return free[0].base;
  }
  up.sort((a, b) => a.waiting - b.waiting || Number(a.base === avoid) - Number(b.base === avoid) || a.index - b.index);
  return up[0].base;
}

// While a login waits at `position` in line on one server: another server where it would get further
// ahead (a free slot = start now, or a shorter line), if any. Moving only to free servers let one
// line grow while new arrivals kept the other server busy, so later arrivals were served first.
async function betterServerThan(current: string, position: number): Promise<string | null> {
  const answers = await Promise.all(
    API_BASES.filter((b) => b !== current).map(async (base) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      try {
        const r = await fetch(`${base}/api/capacity`, { signal: ctrl.signal, cache: "no-store" });
        if (!r.ok) return null;
        const d = await r.json();
        // Place we'd have there: 0 = starts at once, otherwise behind everyone already waiting
        const place = Number(d.free_slots ?? 0) > 0 ? 0 : Number(d.waiting ?? 999) + 1;
        return { base, place };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })
  );
  const best = answers
    .filter((a): a is { base: string; place: number } => a !== null && a.place < position)
    .sort((a, b) => a.place - b.place)[0];
  return best?.base ?? null;
}

// Tells a server this page left a login (moved to another server, or the tab is closing) so its
// place in line is freed at once. sendBeacon is delivered even while the page unloads.
function sendLeave(base: string, ticket: string, reason: "moved" | "left") {
  const body = JSON.stringify({ ticket, reason });
  try {
    if (navigator.sendBeacon?.(`${base}/api/leave`, body)) return;
  } catch {
    // fall through to fetch
  }
  void fetch(`${base}/api/leave`, { method: "POST", body, keepalive: true }).catch(() => {});
}

// How many times one login may move to another server while waiting in line (stops ping-pong)
const MAX_HOPS = 3;

function ThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono transition-all cursor-pointer shadow-xs ${
        isDark
          ? "bg-[#161616] hover:bg-[#202020] border-[#2b2b2b] text-[#cccccc] hover:text-white"
          : "bg-white hover:bg-slate-100 border-slate-200 text-slate-700 hover:text-slate-900"
      }`}
      title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
    >
      {isDark ? (
        <>
          <Sun className="w-3.5 h-3.5 text-amber-400" />
          <span>Light</span>
        </>
      ) : (
        <>
          <Moon className="w-3.5 h-3.5 text-slate-600" />
          <span>Dark</span>
        </>
      )}
    </button>
  );
}

type LoginStep = "connect" | "verify" | "login" | "fetch";

const LOGIN_STEPS: { key: LoginStep; label: string }[] = [
  { key: "connect", label: "Connecting to portal" },
  { key: "verify", label: "Security check" },
  { key: "login", label: "Signing in" },
  { key: "fetch", label: "Loading results" },
];

function LoginProgress({
  step,
  message,
  queuePosition,
  elapsed,
  isDark,
}: {
  step: LoginStep;
  message: string;
  queuePosition: number | null;
  elapsed: number;
  isDark: boolean;
}) {
  const currentIndex = LOGIN_STEPS.findIndex((s) => s.key === step);
  return (
    <div
      className={`rounded-lg border p-4 space-y-3 ${
        isDark ? "bg-[#101010] border-[#2b2b2b]" : "bg-slate-50 border-slate-200"
      }`}
      aria-live="polite"
    >
      <ol className="space-y-2">
        {LOGIN_STEPS.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <li key={s.key} className="flex items-center space-x-2.5 text-sm">
              {done ? (
                <CheckCircle2 className={`w-4 h-4 flex-shrink-0 ${isDark ? "text-[#3ecf8e]" : "text-teal-600"}`} />
              ) : active ? (
                <Loader2 className={`w-4 h-4 flex-shrink-0 animate-spin ${isDark ? "text-[#3ecf8e]" : "text-teal-600"}`} />
              ) : (
                <span className={`w-4 h-4 flex-shrink-0 rounded-full border ${isDark ? "border-[#3a3a3a]" : "border-slate-300"}`} />
              )}
              <span
                className={
                  active
                    ? isDark ? "text-white font-mono" : "text-slate-900 font-medium"
                    : done
                      ? isDark ? "text-[#888888] font-mono" : "text-slate-500"
                      : isDark ? "text-[#555555] font-mono" : "text-slate-400"
                }
              >
                {s.label}
                {active && s.key === "connect" && queuePosition !== null && (
                  <span className={isDark ? "text-amber-400" : "text-amber-600"}> · #{queuePosition} in line</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <div className={`flex justify-between text-xs pt-2 border-t ${
        isDark ? "border-[#222222] text-[#777777] font-mono" : "border-slate-200 text-slate-500"
      }`}>
        <span className="truncate pr-3">{message}</span>
        <span className="tabular-nums flex-shrink-0">{elapsed}s</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [studentId, setStudentId] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("theme") : null;
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
    } else {
      setTheme("dark");
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };

  const isDark = theme === "dark";
  
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [loginStep, setLoginStep] = useState<LoginStep>("connect");
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isLoading) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isLoading]);
  const [isStreaming, setIsStreaming] = useState(false);
  
  const [challengeData, setChallengeData] = useState<ChallengeData | null>(null);
  const [isClicking, setIsClicking] = useState(false);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Ref (not state) so the SSE loop's closure sees the current value
  const clickedRef = useRef(false);
  // The server chosen for the current login; the captcha click must go to the same one.
  const activeApiRef = useRef(API_BASE);
  // The login in progress (its server and private ticket), so closing the tab can free its place
  const liveLoginRef = useRef<{ base: string; ticket: string } | null>(null);
  useEffect(() => {
    const onPageHide = () => {
      const live = liveLoginRef.current;
      if (live) sendLeave(live.base, live.ticket, "left");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const [data, setData] = useState<StudentData | null>(null);

  const handleChallengeClick = async (e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>) => {
    if (!challengeData || isClicking || clickedRef.current) return;
    clickedRef.current = true;
    setIsClicking(true);

    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => {
      clickedRef.current = false;
      setIsClicking(false);
    }, 15000); // backend polls up to ~10s after a click before answering

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = (challengeData.box.width || rect.width) / (rect.width || 1);
    const scaleY = (challengeData.box.height || rect.height) / (rect.height || 1);

    let clientX = 0;
    let clientY = 0;
    if ("touches" in e && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if ("clientX" in e) {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    } else {
      clientX = rect.left + 21;
      clientY = rect.top + 33;
    }

    const relX = (clientX - rect.left) * scaleX;
    const relY = (clientY - rect.top) * scaleY;

    // Standard Cloudflare Turnstile checkbox center inside widget (x: 21, y: 33)
    let clickX = (challengeData.box.x || 0) + 21;
    let clickY = (challengeData.box.y || 0) + 33;

    if (relX >= 0 && relY >= 0) {
      if (relX < 210 && relY < 70) {
        clickX = (challengeData.box.x || 0) + 21;
        clickY = (challengeData.box.y || 0) + 33;
      } else {
        clickX = (challengeData.box.x || 0) + relX;
        clickY = (challengeData.box.y || 0) + relY;
      }
    }

    try {
      const res = await fetch(`${activeApiRef.current}/api/captcha-click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: challengeData.sessionId,
          x: clickX,
          y: clickY
        })
      });
      if (!res.ok) throw new Error(`click not accepted (${res.status})`);
      // Close the popup right away; the progress panel shows the rest. If Cloudflare wants
      // another click, the backend sends challenge_retry and a fresh checkbox reopens it.
      setChallengeData(null);
      setLoadingMsg("Checking your verification...");
    } catch (err) {
      console.error("Failed to forward captcha click:", err);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      clickedRef.current = false;
      setIsClicking(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    setLoadingMsg("Connecting to DIU Student Portal...");
    setLoginStep("connect");
    setQueuePosition(null);
    clickedRef.current = false;
    setChallengeData(null);

    type Outcome =
      | { kind: "done" }
      | { kind: "stalled" }
      | { kind: "hop"; to: string; from: string; last?: boolean };

    // One login attempt. Resolves "stalled" when the server reports that DIU's page froze (a fresh
    // browser usually works, so the caller retries once), "hop" when it should move to a server that
    // has a free slot; throws on any other failure.
    // prefer: go straight to this server (a hop); hopFrom: the server a hop left; avoid: see pickServer.
    const attempt = async (opts: {
      prefer?: string;
      hopFrom?: string;
      avoid?: string;
      allowHop: boolean;
    }): Promise<Outcome> => {
      // Choose the least-busy server, then try it; if it can't be reached (network error or the
      // tunnel/gateway is down), fall back to the others in primary-first order. A real answer
      // from a server -- including 429/422 -- is kept, not retried.
      const first = opts.prefer ?? (await pickServer(opts.avoid));
      const ordered = [first, ...API_BASES.filter((b) => b !== first)];
      let response: Response | null = null;
      let lastErr: unknown = null;
      for (const base of ordered) {
        try {
          const r = await fetch(`${base}/api/scrape-stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ student_id: studentId.trim(), password: password.trim() }),
          });
          if (r.status >= 502 && r.status <= 504) {
            lastErr = new Error(`server ${base} unavailable (${r.status})`);
            continue; // tunnel/gateway down: try the next server
          }
          activeApiRef.current = base;
          response = r;
          break;
        } catch (e) {
          lastErr = e; // network-level failure: try the next server
        }
      }
      if (!response) {
        throw new Error("Unable to reach the calculation server. Please try again.");
      }
      void lastErr;

      if (response.status === 429) {
        // A move to a free server was refused: go back to the original one and stay there
        if (opts.hopFrom && activeApiRef.current !== opts.hopFrom) {
          return { kind: "hop", to: opts.hopFrom, from: activeApiRef.current, last: true };
        }
        const detail = await response.json().then((d) => d?.detail).catch(() => null);
        throw new Error(typeof detail === "string" ? detail : "Too many attempts. Please wait a minute and try again.");
      }
      if (response.status === 422) {
        throw new Error("Please check your Student ID (digits and dashes only).");
      }
      if (!response.ok || !response.body) {
        throw new Error("Unable to reach the calculation server. Please try again.");
      }

      setIsStreaming(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      let serverEnded = false; // the server finished this login itself (result or error)
      let lastByteAt = Date.now();
      const idleCheck = setInterval(() => {
        if (Date.now() - lastByteAt > STREAM_IDLE_LIMIT_MS) void reader.cancel().catch(() => {});
      }, 5000);

      // While this login waits in line, keep checking the other servers and move to one where it
      // would be further ahead (a free slot, or a shorter line). Logins that arrive in the same
      // second all see the same server free and pick it; this spreads them out within seconds and
      // keeps the lines even. Checks are paced by place in line, so the front of the line moves
      // first and the others see that place taken instead of all jumping to it at once.
      const here = activeApiRef.current;
      let ticket: string | null = null;
      let waiting = false;
      let linePosition = 1;
      const hopCheckDelay = (first: boolean) =>
        (first ? 300 : 2000) + (linePosition - 1) * 1500 + Math.random() * 400;
      let hopTo: string | null = null;
      let hopTimer: ReturnType<typeof setTimeout> | null = null;
      const stopHopWatch = () => {
        waiting = false;
        if (hopTimer) clearTimeout(hopTimer);
        hopTimer = null;
      };
      const watchForBetterServer = (delayMs: number) => {
        hopTimer = setTimeout(async () => {
          if (!waiting) return;
          let better = await betterServerThan(here, linePosition);
          if (better && linePosition > 1) {
            // Someone ahead of us in line is probably moving there too: give them time to take
            // that place, then look again, rather than both leaving and one of us ending up behind.
            await new Promise((r) => setTimeout(r, (linePosition - 1) * 1500));
            if (!waiting) return;
            better = await betterServerThan(here, linePosition);
          }
          if (!waiting) return; // our turn came meanwhile
          if (better) {
            hopTo = better;
            if (ticket) sendLeave(here, ticket, "moved"); // frees our place here at once
            void reader.cancel().catch(() => {});
          } else {
            watchForBetterServer(hopCheckDelay(false));
          }
        }, delayMs);
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          lastByteAt = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            try {
              const payload = JSON.parse(trimmed.replace(/^data:\s*/, ""));

              if (payload.type === "ticket") {
                ticket = String(payload.id);
                liveLoginRef.current = { base: here, ticket };
              } else if (payload.type === "queue") {
                setQueuePosition(payload.position ?? null);
                setLoadingMsg(payload.message);
                linePosition = Math.max(1, Number(payload.position) || 1);
                if (opts.allowHop && API_BASES.length > 1 && !waiting) {
                  waiting = true;
                  watchForBetterServer(hopCheckDelay(true));
                }
              } else if (payload.type === "status") {
                stopHopWatch(); // out of the line: the login has started here
                if (payload.step) {
                  setLoginStep(payload.step);
                  if (payload.step !== "connect") setQueuePosition(null);
                }
                setLoadingMsg(payload.message);
              } else if (payload.type === "challenge_required") {
                // After a click the popup stays closed; a frame that was already on its way must not
                // reopen it. Only a challenge_retry (Cloudflare wants another click) re-arms it.
                if (!clickedRef.current) {
                  if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
                  setChallengeData({
                    sessionId: payload.session_id,
                    image: payload.image,
                    box: payload.box || { x: 0, y: 0, width: 300, height: 65 }
                  });
                  setIsClicking(false);
                }
              } else if (payload.type === "challenge_retry") {
                // The screenshot is stale; close the modal until the backend sends a fresh challenge_required
                if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
                clickedRef.current = false;
                setChallengeData(null);
                setIsClicking(false);
                setLoadingMsg(payload.message || "Please click the checkbox again.");
              } else if (payload.type === "challenge_solved") {
                if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
                clickedRef.current = false;
                setChallengeData(null);
                setIsClicking(false);
              } else if (payload.type === "error") {
                serverEnded = true;
                if (payload.code === "stalled") return { kind: "stalled" };
                throw new Error(payload.message || "Scraping failed.");
              } else if (payload.type === "student") {
                setChallengeData(null);
                setData({
                  student: payload.data,
                  overall_cgpa: 0.0,
                  total_credits: 0.0,
                  total_completed_credits: 0.0,
                  semesters: []
                });
                setIsLoading(false);
              } else if (payload.type === "semester") {
                setData((prev) => {
                  if (!prev) return null;
                  const existing = prev.semesters.filter(s => s.name !== payload.data.name);
                  return {
                    ...prev,
                    overall_cgpa: payload.running_cgpa,
                    total_credits: payload.total_credits,
                    total_completed_credits: payload.completed_credits,
                    semesters: [...existing, payload.data]
                  };
                });
              } else if (payload.type === "complete") {
                setData((prev) => {
                  if (!prev) return null;
                  return {
                    ...prev,
                    overall_cgpa: payload.overall_cgpa,
                    total_credits: payload.total_credits,
                    total_completed_credits: payload.total_completed_credits
                  };
                });
                setIsStreaming(false);
                finished = true;
              }
            } catch (jsonErr: any) {
              if (jsonErr.message && !jsonErr.message.includes("Unexpected token")) {
                throw jsonErr;
              }
            }
          }
        }
      } finally {
        stopHopWatch();
        // Ended without an answer from the server: the tab is closing or reloading (the browser
        // cancels this connection before "pagehide" fires), or the network dropped. Tell the server
        // so our place in line or slot frees at once instead of ~15s later.
        if (!finished && !serverEnded && !hopTo && ticket) sendLeave(here, ticket, "left");
        liveLoginRef.current = null;
        clearInterval(idleCheck);
        void reader.cancel().catch(() => {});
      }
      if (hopTo) return { kind: "hop", to: hopTo, from: here };
      // Ended without a result or an error: the connection dropped mid-login
      if (!finished) throw new Error("Lost connection to the server. Please try again.");
      return { kind: "done" };
    };

    try {
      let next: { prefer?: string; hopFrom?: string; avoid?: string } = {};
      let hops = 0;
      let stalls = 0;
      while (true) {
        const outcome = await attempt({ ...next, allowHop: hops < MAX_HOPS });
        if (outcome.kind === "done") break;
        if (outcome.kind === "hop") {
          hops = outcome.last ? MAX_HOPS : hops + 1;
          next = { prefer: outcome.to, hopFrom: outcome.from };
          setQueuePosition(null);
          setLoadingMsg("Moving you to a free server...");
          continue;
        }
        // DIU's page froze in that server's browser: start over once with a fresh browser,
        // on the other server when it is free.
        if (++stalls > 1) {
          throw new Error("DIU's login page stopped responding. Please try again in a minute.");
        }
        clickedRef.current = false;
        setChallengeData(null);
        setIsClicking(false);
        setLoginStep("connect");
        setLoadingMsg("DIU's page froze - retrying with a fresh browser...");
        next = { avoid: activeApiRef.current };
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setData(null);
    } finally {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      setIsLoading(false);
      setIsStreaming(false);
      clickedRef.current = false;
      setChallengeData(null);
      setIsClicking(false);
    }
  };

  return (
    <>
      {/* Interactive Human-in-the-Loop Challenge Modal */}
      {challengeData && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-xs ${
          isDark ? "bg-black/80" : "bg-slate-900/60 backdrop-blur-sm"
        }`}>
          <div className={`rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center border animate-in fade-in zoom-in duration-200 ${
            isDark ? "bg-[#161616] border-[#2b2b2b] text-white" : "bg-white border-slate-100 text-slate-800"
          }`}>
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 border ${
              isDark ? "bg-[#3ecf8e]/10 border-[#3ecf8e]/20 text-[#3ecf8e]" : "bg-teal-50 border-transparent text-teal-600"
            }`}>
              <ShieldCheck className="w-6 h-6" />
            </div>
            <h3 className={`text-lg font-bold mb-1 ${isDark ? "text-white font-mono" : "text-slate-800"}`}>Quick Security Check</h3>
            <p className={`text-xs mb-5 ${isDark ? "text-[#888888] font-mono" : "text-slate-500"}`}>
              Click the checkbox below to continue
            </p>
            
            <div 
              role="button"
              tabIndex={0}
              onClick={handleChallengeClick}
              onTouchStart={handleChallengeClick}
              className={`relative inline-block border rounded-lg overflow-hidden cursor-pointer shadow-sm transition-colors touch-manipulation select-none ${
                isDark ? "border-[#2e2e2e] hover:border-[#3ecf8e]" : "border-slate-200 hover:border-teal-500"
              }`}
            >
              <img 
                src={challengeData.image} 
                alt="Cloudflare Verification"
                className="block max-w-full pointer-events-none select-none"
                draggable={false}
              />
              {isClicking && (
                <div className={`absolute inset-0 backdrop-blur-[1px] flex items-center justify-center space-x-2 text-xs font-medium ${
                  isDark ? "bg-black/70 text-[#3ecf8e] font-mono" : "bg-white/80 text-teal-700"
                }`}>
                  <Loader2 className={`w-4 h-4 animate-spin ${isDark ? "text-[#3ecf8e]" : "text-teal-600"}`} />
                  <span>Solving challenge...</span>
                </div>
              )}
            </div>

            <p className={`text-[11px] mt-4 ${isDark ? "text-[#666666] font-mono" : "text-slate-400"}`}>
              Cloudflare needs one click to confirm you're human
            </p>
          </div>
        </div>
      )}

      {data ? (
        <Dashboard
          data={data}
          isStreaming={isStreaming}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onLogout={() => {
            setData(null);
            setPassword("");
          }}
        />
      ) : (
        <main className={`min-h-screen flex items-center justify-center p-4 relative ${
          isDark ? "bg-[#0e0e0e] text-[#ededed]" : "bg-slate-50 text-slate-900"
        }`}>
          {/* Top-Right Theme Toggle */}
          <div className="absolute top-5 right-5 flex items-center space-x-3">
            <ThemeToggle isDark={isDark} onToggle={toggleTheme} />
          </div>

          <div className={`max-w-md w-full rounded-2xl shadow-xl overflow-hidden border transition-all ${
            isDark ? "bg-[#141414] border-[#252525] shadow-2xl" : "bg-white border-slate-100 shadow-xl"
          }`}>
            <div className={`p-8 text-center ${
              isDark ? "bg-[#181818] border-b border-[#252525]" : "bg-teal-700"
            }`}>
              <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">DIU CGPA Calculator</h1>
              <p className={`text-sm ${isDark ? "text-[#3ecf8e] font-mono text-xs" : "text-teal-100"}`}>
                Real-time Student Portal Scraper
              </p>
            </div>
            
            <div className="p-8">
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className={`block mb-2 ${
                    isDark ? "text-xs font-mono uppercase tracking-wider text-[#888888]" : "text-sm font-medium text-slate-700"
                  }`}>
                    Student ID or Registration ID
                  </label>
                  <input
                    type="text"
                    required
                    className={`w-full px-4 py-3 rounded-lg border outline-none transition ${
                      isDark
                        ? "bg-[#101010] border-[#2b2b2b] text-white font-mono placeholder-[#555555] focus:border-[#3ecf8e] focus:ring-1 focus:ring-[#3ecf8e]"
                        : "bg-white border-slate-300 text-slate-900 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    }`}
                    maxLength={24}
                    autoComplete="username"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                  />
                </div>
                
                <div>
                  <label className={`block mb-2 ${
                    isDark ? "text-xs font-mono uppercase tracking-wider text-[#888888]" : "text-sm font-medium text-slate-700"
                  }`}>
                    Student Portal Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      className={`w-full pl-4 pr-12 py-3 rounded-lg border outline-none transition ${
                        isDark
                          ? "bg-[#101010] border-[#2b2b2b] text-white font-mono placeholder-[#555555] focus:border-[#3ecf8e] focus:ring-1 focus:ring-[#3ecf8e]"
                          : "bg-white border-slate-300 text-slate-900 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      }`}
                      maxLength={64}
                      autoComplete="current-password"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                      title={showPassword ? "Hide password" : "Show password"}
                      className={`absolute inset-y-0 right-0 flex items-center px-3.5 rounded-r-lg transition cursor-pointer ${
                        isDark ? "text-[#777777] hover:text-[#3ecf8e]" : "text-slate-400 hover:text-teal-600"
                      }`}
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className={`p-4 rounded-lg flex items-start space-x-3 text-sm border ${
                    isDark ? "bg-red-950/40 border-red-500/30 text-red-300" : "bg-red-50 border-transparent text-red-700"
                  }`}>
                    <AlertCircle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${isDark ? "text-red-400" : "text-red-600"}`} />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className={`w-full font-semibold py-3 px-4 rounded-lg transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed shadow-md cursor-pointer ${
                    isDark
                      ? "bg-[#3ecf8e] hover:bg-[#34b27b] text-black font-bold active:scale-[0.99] font-mono text-sm"
                      : "bg-teal-600 hover:bg-teal-700 text-white font-semibold"
                  }`}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className={`w-5 h-5 mr-2 animate-spin ${isDark ? "text-black" : "text-white"}`} />
                      <span>Please wait…</span>
                    </>
                  ) : (
                    "View Results"
                  )}
                </button>

                {isLoading && (
                  <LoginProgress
                    step={loginStep}
                    message={loadingMsg}
                    queuePosition={queuePosition}
                    elapsed={elapsed}
                    isDark={isDark}
                  />
                )}
              </form>
            </div>
          </div>
        </main>
      )}
    </>
  );
}

function Dashboard({
  data,
  isStreaming,
  onLogout,
  isDark,
  onToggleTheme,
}: {
  data: StudentData;
  isStreaming: boolean;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <div className={`min-h-screen ${isDark ? "bg-[#0e0e0e] text-[#ededed]" : "bg-slate-50 text-slate-900"}`}>
      <header className={`shadow-lg sticky top-0 z-10 ${
        isDark ? "bg-[#141414] border-b border-[#242424] text-white" : "bg-teal-700 text-white"
      }`}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold">DIU Academic Portal</h1>
            <p className={`text-sm ${isDark ? "text-[#3ecf8e] font-mono text-xs" : "text-teal-100"}`}>
              {data.student.name || data.student.id} • {data.student.id}
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <ThemeToggle isDark={isDark} onToggle={onToggleTheme} />
            <button 
              onClick={onLogout}
              className={`text-sm px-4 py-2 rounded-md transition-colors font-medium border cursor-pointer ${
                isDark
                  ? "bg-[#1c1c1c] hover:bg-[#252525] border-[#2c2c2c] text-white"
                  : "bg-teal-800 hover:bg-teal-900 border-teal-600 text-white"
              }`}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Live Loading Banner */}
        {isStreaming ? (
          <div className={`p-4 rounded-xl flex items-center justify-between shadow-sm animate-pulse border ${
            isDark ? "bg-[#14231d] border-[#3ecf8e]/30 text-[#3ecf8e]" : "bg-teal-50 border-teal-200 text-teal-800"
          }`}>
            <div className="flex items-center space-x-3">
              <Loader2 className={`w-5 h-5 animate-spin ${isDark ? "text-[#3ecf8e]" : "text-teal-600"}`} />
              <span className="font-medium text-sm">Loading and calculating semesters in real-time...</span>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isDark ? "bg-[#3ecf8e]/20 text-[#3ecf8e]" : "bg-teal-200/60 text-teal-900"
            }`}>
              Live Streaming
            </span>
          </div>
        ) : (
          <div className={`p-3.5 rounded-xl flex items-center justify-between shadow-sm text-sm border ${
            isDark ? "bg-[#121c17] border-emerald-500/20 text-emerald-400 font-mono text-xs" : "bg-emerald-50 border-emerald-200 text-emerald-800"
          }`}>
            <div className="flex items-center space-x-2.5">
              <CheckCircle2 className={`w-4 h-4 ${isDark ? "text-[#3ecf8e]" : "text-emerald-600"}`} />
              <span className="font-medium">All published academic results loaded successfully</span>
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
              isDark ? "bg-[#3ecf8e]/10 text-[#3ecf8e] border border-[#3ecf8e]/30" : "bg-emerald-100 text-emerald-700"
            }`}>
              Complete
            </span>
          </div>
        )}

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className={`rounded-2xl shadow-sm border p-6 flex flex-col items-center justify-center text-center ${
            isDark ? "bg-[#161616] border-[#242424]" : "bg-white border-slate-200"
          }`}>
            <p className={`text-sm font-medium uppercase tracking-wider mb-2 ${
              isDark ? "text-[#888888] font-mono text-xs" : "text-slate-500"
            }`}>
              Overall Weighted CGPA
            </p>
            <p className={`text-5xl font-extrabold transition-all duration-300 ${
              isDark ? "text-[#3ecf8e] font-mono" : "text-teal-600"
            }`}>
              {data.overall_cgpa > 0 ? data.overall_cgpa.toFixed(2) : "0.00"}
            </p>
            {isStreaming && (
              <span className={`text-[11px] mt-2 font-medium ${isDark ? "text-[#3ecf8e]/70" : "text-teal-500"}`}>
                Updating live...
              </span>
            )}
          </div>
          
          <div className={`rounded-2xl shadow-sm border p-6 flex flex-col justify-center ${
            isDark ? "bg-[#161616] border-[#242424]" : "bg-white border-slate-200"
          }`}>
            <p className={`text-sm font-medium mb-1 ${isDark ? "text-[#888888] font-mono text-xs uppercase" : "text-slate-500"}`}>
              Student Information
            </p>
            <p className={`font-semibold ${isDark ? "text-white text-base" : "text-slate-800"}`}>
              {data.student.name || "Student"}
            </p>
            <p className={`text-sm mt-0.5 ${isDark ? "text-[#a3a3a3] font-mono text-xs" : "text-slate-600"}`}>
              {data.student.department} • Campus: {data.student.campus}
            </p>
            {data.student.email && (
              <p className={`text-xs mt-1 truncate ${isDark ? "text-[#666666] font-mono" : "text-slate-400"}`}>
                {data.student.email}
              </p>
            )}
          </div>
          
          <div className={`rounded-2xl shadow-sm border p-6 flex flex-col justify-center ${
            isDark ? "bg-[#161616] border-[#242424]" : "bg-white border-slate-200"
          }`}>
            <p className={`text-sm font-medium mb-1 ${isDark ? "text-[#888888] font-mono text-xs uppercase" : "text-slate-500"}`}>
              Credits Summary
            </p>
            <div className="flex justify-between items-end mt-2">
              <div>
                <p className={`text-2xl font-bold ${isDark ? "text-white font-mono" : "text-slate-800"}`}>
                  {data.total_completed_credits}
                </p>
                <p className={`text-xs ${isDark ? "text-[#888888] font-mono" : "text-slate-500"}`}>Completed Credits</p>
              </div>
              <div className="text-right">
                <p className={`text-xl font-semibold ${isDark ? "text-[#a3a3a3] font-mono" : "text-slate-600"}`}>
                  {data.total_credits}
                </p>
                <p className={`text-xs ${isDark ? "text-[#888888] font-mono" : "text-slate-500"}`}>Total Credits</p>
              </div>
            </div>
          </div>
        </div>

        {/* Semesters Grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-xl font-bold ${isDark ? "text-white font-mono" : "text-slate-800"}`}>
              Semester Breakdowns ({data.semesters.length})
            </h2>
            {isStreaming && (
              <span className={`text-xs flex items-center ${isDark ? "text-[#888888] font-mono" : "text-slate-400"}`}>
                <Loader2 className={`w-3.5 h-3.5 mr-1.5 animate-spin ${isDark ? "text-[#3ecf8e]" : ""}`} /> Scanning more semesters...
              </span>
            )}
          </div>

          {data.semesters.length === 0 ? (
            <div className={`rounded-xl border p-12 text-center ${
              isDark ? "bg-[#161616] border-[#242424] text-[#666666] font-mono" : "bg-white border-slate-200 text-slate-400"
            }`}>
              <Loader2 className={`w-8 h-8 animate-spin mx-auto mb-3 ${isDark ? "text-[#3ecf8e]" : "text-teal-600"}`} />
              <p className="text-sm">Fetching and calculating your first semester...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {data.semesters.map((sem, i) => (
                <SemesterCard key={i} semester={sem} isDark={isDark} />
              ))}
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

function SemesterCard({ semester, isDark }: { semester: Semester; isDark: boolean }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`rounded-xl shadow-sm border overflow-hidden transition-all duration-300 hover:shadow-md animate-fadeIn ${
      isDark ? "bg-[#161616] border-[#242424]" : "bg-white border-slate-200"
    }`}>
      <div 
        className={`p-5 flex items-center justify-between cursor-pointer transition-colors ${
          isDark ? "hover:bg-[#1c1c1c]" : "hover:bg-slate-50"
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <h3 className={`font-bold text-lg ${isDark ? "text-white font-mono" : "text-slate-800"}`}>{semester.name}</h3>
          <p className={`text-sm ${isDark ? "text-[#888888] font-mono text-xs" : "text-slate-500"}`}>{semester.credits} Total Credits</p>
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-right">
            <span className={`block text-xs uppercase font-semibold ${isDark ? "text-[#666666] font-mono text-[10px]" : "text-slate-400"}`}>Semester GPA</span>
            <span className={`font-bold text-xl ${isDark ? "text-[#3ecf8e] font-mono" : "text-teal-600"}`}>
              {semester.gpa > 0 ? semester.gpa.toFixed(2) : "0.00"}
            </span>
          </div>
          {expanded ? (
            <ChevronUp className={`w-5 h-5 ${isDark ? "text-[#666666]" : "text-slate-400"}`} />
          ) : (
            <ChevronDown className={`w-5 h-5 ${isDark ? "text-[#666666]" : "text-slate-400"}`} />
          )}
        </div>
      </div>
      
      {expanded && semester.courses && semester.courses.length > 0 && (
        <div className={`border-t p-4 ${
          isDark ? "border-[#222222] bg-[#121212]" : "border-slate-100 bg-slate-50"
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className={`text-xs uppercase ${
                isDark ? "text-[#777777] font-mono text-[10px] bg-[#181818] border-b border-[#222222]" : "text-slate-500 bg-slate-100/80"
              }`}>
                <tr>
                  <th className="px-3 py-2 rounded-l">Course</th>
                  <th className="px-2 py-2 text-center">Cr.</th>
                  <th className="px-2 py-2 text-center">Grade</th>
                  <th className="px-3 py-2 text-right rounded-r">GP</th>
                </tr>
              </thead>
              <tbody className={isDark ? "divide-y divide-[#1e1e1e]" : ""}>
                {semester.courses.map((course, i) => (
                  <tr key={i} className={`border-b last:border-0 transition-colors ${
                    isDark
                      ? "border-[#1e1e1e] hover:bg-[#181818]"
                      : "border-slate-200/60 hover:bg-slate-100/50"
                  }`}>
                    <td className="px-3 py-2.5">
                      <div className={`font-medium ${isDark ? "text-[#3ecf8e] font-mono" : "text-slate-800"}`}>{course.code}</div>
                      <div className={`text-xs truncate max-w-[200px] sm:max-w-xs ${isDark ? "text-[#cccccc]" : "text-slate-500"}`}>{course.name}</div>
                    </td>
                    <td className={`px-2 py-2.5 text-center font-medium ${isDark ? "text-[#cccccc] font-mono" : ""}`}>{course.credits}</td>
                    <td className="px-2 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                        course.grade === 'A+' || course.grade === 'A'
                          ? (isDark ? "bg-emerald-950/60 text-[#3ecf8e] border border-emerald-500/30" : "bg-emerald-100 text-emerald-800")
                          : course.grade === 'I'
                          ? (isDark ? "bg-amber-950/60 text-amber-400 border border-amber-500/30" : "bg-amber-100 text-amber-800")
                          : course.grade === 'F'
                          ? (isDark ? "bg-red-950/60 text-red-400 border border-red-500/30" : "bg-red-100 text-red-800")
                          : (isDark ? "bg-[#222222] text-[#aaaaaa]" : "bg-slate-200 text-slate-700")
                      }`}>
                        {course.grade || 'N/A'}
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${isDark ? "text-[#aaaaaa] font-mono" : "text-slate-700"}`}>
                      {course.grade_point > 0 ? course.grade_point.toFixed(2) : "0.00"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
