"use client";

import { useState, useEffect } from "react";
import { 
  ChevronDown, 
  ChevronUp, 
  AlertCircle, 
  Loader2, 
  CheckCircle2, 
  ShieldCheck,
  Sun,
  Moon
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

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://direct-occupational-com-fellowship.trycloudflare.com";

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

export default function Home() {
  const [studentId, setStudentId] = useState("");
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
  const [error, setError] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  
  const [challengeData, setChallengeData] = useState<ChallengeData | null>(null);
  const [isClicking, setIsClicking] = useState(false);

  const [data, setData] = useState<StudentData | null>(null);

  const handleChallengeClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!challengeData || isClicking) return;
    setIsClicking(true);

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = (challengeData.box.width || rect.width) / rect.width;
    const scaleY = (challengeData.box.height || rect.height) / rect.height;

    const relX = (e.clientX - rect.left) * scaleX;
    const relY = (e.clientY - rect.top) * scaleY;

    // Standard Cloudflare Turnstile checkbox is located at ~(x: 28, y: 32)
    // If the user clicked anywhere inside the interactive left/center area,
    // smart-target the checkbox center directly for 100% reliable trigger:
    let clickX = (challengeData.box.x || 0) + relX;
    let clickY = (challengeData.box.y || 0) + relY;

    if (relX < 210 && relY < 70) {
      clickX = (challengeData.box.x || 0) + 28;
      clickY = (challengeData.box.y || 0) + 32;
    }

    try {
      await fetch(`${API_BASE}/api/captcha-click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: challengeData.sessionId,
          x: clickX,
          y: clickY
        })
      });
    } catch (err) {
      console.error("Failed to forward captcha click:", err);
      setIsClicking(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    setLoadingMsg("Connecting to DIU Student Portal...");
    setChallengeData(null);

    try {
      const response = await fetch(`${API_BASE}/api/scrape-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student_id: studentId.trim(), password: password.trim() }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Unable to reach the calculation server. Please try again.");
      }

      setIsStreaming(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          try {
            const payload = JSON.parse(trimmed.replace(/^data:\s*/, ""));

            if (payload.type === "status") {
              setLoadingMsg(payload.message);
            } else if (payload.type === "challenge_required") {
              setChallengeData({
                sessionId: payload.session_id,
                image: payload.image,
                box: payload.box || { x: 0, y: 0, width: 300, height: 65 }
              });
              setIsClicking(false);
            } else if (payload.type === "challenge_solved") {
              setChallengeData(null);
              setIsClicking(false);
            } else if (payload.type === "error") {
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
            }
          } catch (jsonErr: any) {
            if (jsonErr.message && !jsonErr.message.includes("Unexpected token")) {
              throw jsonErr;
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setData(null);
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setChallengeData(null);
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
              Please click the verification box below to verify your request
            </p>
            
            <div className={`relative inline-block border rounded-lg overflow-hidden cursor-pointer shadow-sm transition-colors ${
              isDark ? "border-[#2e2e2e] hover:border-[#3ecf8e]" : "border-slate-200 hover:border-teal-500"
            }`}>
              <img 
                src={challengeData.image} 
                alt="Cloudflare Verification"
                onClick={handleChallengeClick}
                className="block max-w-full select-none"
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
              Click anywhere inside the verification box to proceed
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
                    Student ID
                  </label>
                  <input
                    type="text"
                    required
                    className={`w-full px-4 py-3 rounded-lg border outline-none transition ${
                      isDark
                        ? "bg-[#101010] border-[#2b2b2b] text-white font-mono placeholder-[#555555] focus:border-[#3ecf8e] focus:ring-1 focus:ring-[#3ecf8e]"
                        : "bg-white border-slate-300 text-slate-900 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    }`}
                    placeholder="e.g. xxx-xx-xxx"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                  />
                </div>
                
                <div>
                  <label className={`block mb-2 ${
                    isDark ? "text-xs font-mono uppercase tracking-wider text-[#888888]" : "text-sm font-medium text-slate-700"
                  }`}>
                    Portal Password
                  </label>
                  <input
                    type="password"
                    required
                    className={`w-full px-4 py-3 rounded-lg border outline-none transition ${
                      isDark
                        ? "bg-[#101010] border-[#2b2b2b] text-white font-mono placeholder-[#555555] focus:border-[#3ecf8e] focus:ring-1 focus:ring-[#3ecf8e]"
                        : "bg-white border-slate-300 text-slate-900 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    }`}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
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
                      <span>{loadingMsg}</span>
                    </>
                  ) : (
                    "View Results"
                  )}
                </button>
              </form>

              <div className="mt-8 text-center space-y-4">
                <p className={`text-xs p-4 rounded-lg leading-relaxed ${
                  isDark
                    ? "bg-[#101010] border border-[#222222] text-[#888888] font-mono"
                    : "bg-slate-50 text-slate-500"
                }`}>
                  <strong className={isDark ? "text-[#cccccc]" : "text-slate-700"}>Security Notice:</strong> Your credentials are sent securely to the DIU student portal backend for verification. They are never saved or stored.
                </p>
              </div>
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
