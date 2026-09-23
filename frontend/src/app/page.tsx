"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, AlertCircle, Loader2, CheckCircle2, ShieldCheck } from "lucide-react";

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

export default function Home() {
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  
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
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center border border-slate-100 animate-in fade-in zoom-in duration-200">
            <div className="w-12 h-12 rounded-full bg-teal-50 text-teal-600 flex items-center justify-center mx-auto mb-4">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Quick Security Check</h3>
            <p className="text-xs text-slate-500 mb-5">
              Please click the verification box below to verify your request
            </p>
            
            <div className="relative inline-block border border-slate-200 rounded-lg overflow-hidden cursor-pointer shadow-sm hover:border-teal-500 transition-colors">
              <img 
                src={challengeData.image} 
                alt="Cloudflare Verification"
                onClick={handleChallengeClick}
                className="block max-w-full select-none"
                draggable={false}
              />
              {isClicking && (
                <div className="absolute inset-0 bg-white/80 backdrop-blur-[1px] flex items-center justify-center space-x-2 text-teal-700 text-xs font-medium">
                  <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
                  <span>Solving challenge...</span>
                </div>
              )}
            </div>

            <p className="text-[11px] text-slate-400 mt-4">
              Click anywhere inside the verification box to proceed
            </p>
          </div>
        </div>
      )}

      {data ? (
        <Dashboard
          data={data}
          isStreaming={isStreaming}
          onLogout={() => {
            setData(null);
            setPassword("");
          }}
        />
      ) : (
        <main className="min-h-screen flex items-center justify-center p-4 bg-slate-50">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
            <div className="bg-teal-700 p-8 text-center">
              <h1 className="text-3xl font-bold text-white mb-2">DIU CGPA Calculator</h1>
              <p className="text-teal-100 text-sm">Real-time Student Portal Scraper</p>
            </div>
            
            <div className="p-8">
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Student ID</label>
                  <input
                    type="text"
                    required
                    className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition"
                    placeholder="e.g. xxx-xx-xxx"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Portal Password</label>
                  <input
                    type="password"
                    required
                    className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="bg-red-50 text-red-700 p-4 rounded-lg flex items-start space-x-3 text-sm">
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-teal-600 hover:bg-teal-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed shadow-md"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      {loadingMsg}
                    </>
                  ) : (
                    "View Results"
                  )}
                </button>
              </form>

              <div className="mt-8 text-center space-y-4">
                <p className="text-xs text-slate-500 bg-slate-50 p-4 rounded-lg leading-relaxed">
                  <strong>Security Notice:</strong> Your credentials are sent securely to the DIU student portal backend for verification. They are never saved or stored.
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
  onLogout
}: {
  data: StudentData;
  isStreaming: boolean;
  onLogout: () => void;
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-teal-700 text-white shadow-lg sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold">DIU Academic Portal</h1>
            <p className="text-teal-100 text-sm">
              {data.student.name || data.student.id} • {data.student.id}
            </p>
          </div>
          <button 
            onClick={onLogout}
            className="text-sm bg-teal-800 hover:bg-teal-900 px-4 py-2 rounded-md transition-colors font-medium border border-teal-600"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Live Loading Banner */}
        {isStreaming ? (
          <div className="bg-teal-50 border border-teal-200 text-teal-800 p-4 rounded-xl flex items-center justify-between shadow-sm animate-pulse">
            <div className="flex items-center space-x-3">
              <Loader2 className="w-5 h-5 animate-spin text-teal-600" />
              <span className="font-medium text-sm">Loading and calculating semesters in real-time...</span>
            </div>
            <span className="text-xs font-semibold bg-teal-200/60 px-2.5 py-1 rounded-full text-teal-900">
              Live Streaming
            </span>
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3.5 rounded-xl flex items-center justify-between shadow-sm text-sm">
            <div className="flex items-center space-x-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">All published academic results loaded successfully</span>
            </div>
            <span className="text-xs font-semibold bg-emerald-100 px-2 py-0.5 rounded text-emerald-700">
              Complete
            </span>
          </div>
        )}

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col items-center justify-center text-center">
            <p className="text-sm text-slate-500 font-medium uppercase tracking-wider mb-2">
              Overall Weighted CGPA
            </p>
            <p className="text-5xl font-extrabold text-teal-600 transition-all duration-300">
              {data.overall_cgpa > 0 ? data.overall_cgpa.toFixed(2) : "0.00"}
            </p>
            {isStreaming && (
              <span className="text-[11px] text-teal-500 mt-2 font-medium">Updating live...</span>
            )}
          </div>
          
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col justify-center">
            <p className="text-sm text-slate-500 font-medium mb-1">Student Information</p>
            <p className="font-semibold text-slate-800">{data.student.name || "Student"}</p>
            <p className="text-slate-600 text-sm mt-0.5">{data.student.department} • Campus: {data.student.campus}</p>
            {data.student.email && (
              <p className="text-xs text-slate-400 mt-1 truncate">{data.student.email}</p>
            )}
          </div>
          
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col justify-center">
            <p className="text-sm text-slate-500 font-medium mb-1">Credits Summary</p>
            <div className="flex justify-between items-end mt-2">
              <div>
                <p className="text-2xl font-bold text-slate-800">{data.total_completed_credits}</p>
                <p className="text-xs text-slate-500">Completed Credits</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-semibold text-slate-600">{data.total_credits}</p>
                <p className="text-xs text-slate-500">Total Credits</p>
              </div>
            </div>
          </div>
        </div>

        {/* Semesters Grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-800">
              Semester Breakdowns ({data.semesters.length})
            </h2>
            {isStreaming && (
              <span className="text-xs text-slate-400 flex items-center">
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Scanning more semesters...
              </span>
            )}
          </div>

          {data.semesters.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-teal-600" />
              <p className="text-sm">Fetching and calculating your first semester...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {data.semesters.map((sem, i) => (
                <SemesterCard key={i} semester={sem} />
              ))}
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

function SemesterCard({ semester }: { semester: Semester }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-300 hover:shadow-md animate-fadeIn">
      <div 
        className="p-5 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <h3 className="font-bold text-slate-800 text-lg">{semester.name}</h3>
          <p className="text-sm text-slate-500">{semester.credits} Total Credits</p>
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-right">
            <span className="block text-xs text-slate-400 uppercase font-semibold">Semester GPA</span>
            <span className="font-bold text-teal-600 text-xl">{semester.gpa > 0 ? semester.gpa.toFixed(2) : "0.00"}</span>
          </div>
          {expanded ? <ChevronUp className="text-slate-400 w-5 h-5" /> : <ChevronDown className="text-slate-400 w-5 h-5" />}
        </div>
      </div>
      
      {expanded && semester.courses && semester.courses.length > 0 && (
        <div className="border-t border-slate-100 bg-slate-50 p-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-500 uppercase bg-slate-100/80">
                <tr>
                  <th className="px-3 py-2 rounded-l">Course</th>
                  <th className="px-2 py-2 text-center">Cr.</th>
                  <th className="px-2 py-2 text-center">Grade</th>
                  <th className="px-3 py-2 text-right rounded-r">GP</th>
                </tr>
              </thead>
              <tbody>
                {semester.courses.map((course, i) => (
                  <tr key={i} className="border-b border-slate-200/60 last:border-0 hover:bg-slate-100/50 transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-800">{course.code}</div>
                      <div className="text-xs text-slate-500 truncate max-w-[200px] sm:max-w-xs">{course.name}</div>
                    </td>
                    <td className="px-2 py-2.5 text-center font-medium">{course.credits}</td>
                    <td className="px-2 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                        course.grade === 'A+' || course.grade === 'A' ? 'bg-emerald-100 text-emerald-800' :
                        course.grade === 'I' ? 'bg-amber-100 text-amber-800' :
                        course.grade === 'F' ? 'bg-red-100 text-red-800' :
                        'bg-slate-200 text-slate-700'
                      }`}>
                        {course.grade || 'N/A'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-700">
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
