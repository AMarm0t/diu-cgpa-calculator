"use client";

import React, { useState, useEffect, useCallback } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { 
  ShieldCheck, 
  Search, 
  Trash2, 
  RotateCcw, 
  Eye, 
  LogOut, 
  ArrowLeft, 
  GraduationCap, 
  Users, 
  Award, 
  BookOpen, 
  Clock, 
  X, 
  AlertCircle,
  CheckCircle2,
  Loader2,
  Database,
  Settings,
  Power,
  Play,
  Save,
  ShieldAlert,
  ListOrdered,
  RefreshCw,
  UserX,
  AlertTriangle,
  Activity
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://direct-occupational-com-fellowship.trycloudflare.com";

interface AdminProfile {
  name: string;
  email: string;
  picture?: string;
}

interface StudentSummary {
  student_id: string;
  student_name: string;
  department: string;
  campus: string;
  overall_cgpa: number;
  total_credits: number;
  completed_credits: number;
  last_fetched_at: string;
}

interface CourseItem {
  code: string;
  name: string;
  credits: number;
  grade: string;
  grade_point: number;
}

interface SemesterItem {
  name: string;
  gpa: number;
  credits: number;
  courses: CourseItem[];
}

interface StudentDetailRecord {
  student_id: string;
  student_name: string;
  department: string;
  campus: string;
  overall_cgpa: number;
  total_credits: number;
  completed_credits: number;
  last_fetched_at: string;
  results_json: {
    student: {
      id: string;
      name: string;
      department: string;
      campus: string;
      email: string;
    };
    overall_cgpa: number;
    total_credits: number;
    total_completed_credits: number;
    semesters: SemesterItem[];
  };
}

interface QueueItemRecord {
  queue_id: string;
  student_id: string;
  status: "waiting" | "running";
  queued_at: string;
  started_at?: string | null;
}

interface QueueStatusRecord {
  limit: number;
  active_count: number;
  waiting_count: number;
  running: QueueItemRecord[];
  waiting: QueueItemRecord[];
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const [token, setToken] = useState<string>("");
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  const [authError, setAuthError] = useState<string>("");
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(false);

  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [isLoadingStudents, setIsLoadingStudents] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Inspect Modal
  const [selectedStudent, setSelectedStudent] = useState<StudentDetailRecord | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState<boolean>(false);

  // Status Toast
  const [toastMessage, setToastMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Delete Confirm
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // Active Navigation Tab
  const [activeTab, setActiveTab] = useState<"database" | "settings" | "scrape" | "queue">("database");

  // Queue Manager State
  const [queueData, setQueueData] = useState<QueueStatusRecord | null>(null);
  const [isLoadingQueue, setIsLoadingQueue] = useState<boolean>(false);
  const [isActionQueueLoading, setIsActionQueueLoading] = useState<boolean>(false);
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);

  // System Settings State
  const [cacheTtlMinutes, setCacheTtlMinutes] = useState<number>(60);
  const [publicSearchEnabled, setPublicSearchEnabled] = useState<boolean>(true);
  const [isLoadingSettings, setIsLoadingSettings] = useState<boolean>(false);
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);

  // Admin Direct Scrape State
  const [scrapeStudentId, setScrapeStudentId] = useState<string>("");
  const [scrapePassword, setScrapePassword] = useState<string>("");
  const [isScrapingAdmin, setIsScrapingAdmin] = useState<boolean>(false);
  const [scrapeError, setScrapeError] = useState<string>("");
  const [scrapeProgressMsg, setScrapeProgressMsg] = useState<string>("Connecting to DIU Student Portal...");
  const [challengeData, setChallengeData] = useState<{
    sessionId: string;
    image: string;
    box: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [isClickingChallenge, setIsClickingChallenge] = useState<boolean>(false);

  const showToast = (text: string, type: "success" | "error" = "success") => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // When NextAuth session is available, verify with our backend
  const verifyAndSetToken = useCallback(async (authToken: string) => {
    setIsLoadingAuth(true);
    setAuthError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/me`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Access denied. Not an authorized admin account.");
      }
      const data = await res.json();
      setToken(authToken);
      setAdmin(data.admin);
    } catch (err: any) {
      setAuthError(err.message || "Authentication failed.");
      setAdmin(null);
      setToken("");
    } finally {
      setIsLoadingAuth(false);
    }
  }, []);

  // When NextAuth session loads with an access token, verify it with backend
  useEffect(() => {
    if (status === "authenticated" && session) {
      const authToken = (session as any).accessToken || (session as any).idToken;
      if (authToken && !token) {
        verifyAndSetToken(authToken);
      }
    }
  }, [session, status, token, verifyAndSetToken]);

  // Fetch students list
  const fetchStudents = useCallback(async () => {
    if (!token) return;
    setIsLoadingStudents(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/students`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStudents(data.students || []);
      }
    } catch (err) {
      console.error("Failed to load students:", err);
    } finally {
      setIsLoadingStudents(false);
    }
  }, [token]);

  // Fetch system settings
  const fetchSettings = useCallback(async () => {
    if (!token) return;
    setIsLoadingSettings(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setCacheTtlMinutes(data.settings.cache_ttl_minutes ?? 60);
          setPublicSearchEnabled(data.settings.public_search_enabled ?? true);
        }
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setIsLoadingSettings(false);
    }
  }, [token]);

  // Save system settings
  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          cache_ttl_minutes: Number(cacheTtlMinutes),
          public_search_enabled: publicSearchEnabled
        })
      });
      if (res.ok) {
        showToast("System settings updated successfully.");
      } else {
        showToast("Failed to save settings.", "error");
      }
    } catch {
      showToast("Error connecting to server.", "error");
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Fetch Scraper Queue Status
  const fetchQueue = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/queue`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setQueueData(data.queue);
      }
    } catch (err) {
      console.error("Failed to load queue:", err);
    }
  }, [token]);

  // Remove individual student from queue
  const handleRemoveFromQueue = async (id: string) => {
    if (!token || isActionQueueLoading) return;
    setIsActionQueueLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/queue/remove`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || `Removed ${id} from queue.`, "success");
        fetchQueue();
      } else {
        showToast(data.detail || "Failed to remove item from queue.", "error");
      }
    } catch {
      showToast("Error connecting to server.", "error");
    } finally {
      setIsActionQueueLoading(false);
    }
  };

  // Clear all waiting requests from queue
  const handleClearQueue = async () => {
    if (!token || isActionQueueLoading) return;
    setIsActionQueueLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/queue/clear`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || "Queue cleared successfully.", "success");
        setShowClearConfirm(false);
        fetchQueue();
      } else {
        showToast(data.detail || "Failed to clear queue.", "error");
      }
    } catch {
      showToast("Error connecting to server.", "error");
    } finally {
      setIsActionQueueLoading(false);
    }
  };

  // Forward admin click coordinates to backend to solve Cloudflare Turnstile
  const handleChallengeClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!challengeData || isClickingChallenge) return;
    setIsClickingChallenge(true);

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = (challengeData.box.width || rect.width) / rect.width;
    const scaleY = (challengeData.box.height || rect.height) / rect.height;

    const relX = (e.clientX - rect.left) * scaleX;
    const relY = (e.clientY - rect.top) * scaleY;

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
      setIsClickingChallenge(false);
    }
  };

  // Direct Admin Portal Scrape with live SSE streaming
  const handleAdminScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scrapeStudentId.trim() || !scrapePassword.trim()) {
      setScrapeError("Please provide both Student ID and Password.");
      return;
    }
    setScrapeError("");
    setIsScrapingAdmin(true);
    setScrapeProgressMsg("Connecting to DIU Student Portal...");
    setChallengeData(null);

    try {
      const response = await fetch(`${API_BASE}/api/scrape-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          student_id: scrapeStudentId.trim(),
          password: scrapePassword.trim()
        })
      });

      if (!response.ok || !response.body) {
        throw new Error("Unable to communicate with scraping server.");
      }

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
              setScrapeProgressMsg(payload.message);
            } else if (payload.type === "challenge_required") {
              setChallengeData({
                sessionId: payload.session_id,
                image: payload.image,
                box: payload.box || { x: 0, y: 0, width: 300, height: 65 }
              });
              setIsClickingChallenge(false);
            } else if (payload.type === "challenge_solved") {
              setChallengeData(null);
              setIsClickingChallenge(false);
              setScrapeProgressMsg("Verification passed! Logging in...");
            } else if (payload.type === "error") {
              throw new Error(payload.message || "Scraping failed.");
            } else if (payload.type === "complete") {
              showToast(`Results successfully fetched for ${scrapeStudentId}!`);
              setScrapePassword("");
              fetchStudents();
              handleInspect(scrapeStudentId.trim());
              setChallengeData(null);
            }
          } catch (jsonErr: any) {
            if (jsonErr.message && !jsonErr.message.includes("Unexpected token")) {
              throw jsonErr;
            }
          }
        }
      }
    } catch (err: any) {
      setScrapeError(err?.message || "Failed to communicate with scraping backend.");
    } finally {
      setIsScrapingAdmin(false);
      setChallengeData(null);
    }
  };

  useEffect(() => {
    if (token) {
      fetchStudents();
      fetchSettings();
      fetchQueue();
    }
  }, [token, fetchStudents, fetchSettings, fetchQueue]);

  // Live polling for queue when on queue tab
  useEffect(() => {
    if (activeTab === "queue" && token) {
      fetchQueue();
      const interval = setInterval(fetchQueue, 3000);
      return () => clearInterval(interval);
    }
  }, [activeTab, token, fetchQueue]);

  const handleGoogleSignIn = () => {
    setAuthError("");
    signIn("google", { callbackUrl: "/admin" });
  };

  const handleLogout = async () => {
    setToken("");
    setAdmin(null);
    await signOut({ callbackUrl: "/admin" });
  };

  // Inspect student detail
  const handleInspect = async (studentId: string) => {
    setIsLoadingDetail(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/student/${studentId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedStudent(data.record);
      } else {
        showToast("Failed to fetch student details.", "error");
      }
    } catch {
      showToast("Error retrieving student details.", "error");
    } finally {
      setIsLoadingDetail(false);
    }
  };

  // Reset student cache
  const handleResetCache = async (studentId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/student/${studentId}/reset-cache`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        showToast(`Cache timer expired for ${studentId}.`);
        fetchStudents();
      } else {
        showToast("Failed to reset cache.", "error");
      }
    } catch {
      showToast("Error connecting to server.", "error");
    }
  };

  // Delete student
  const handleDelete = async (studentId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/student/${studentId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        showToast(`Student ${studentId} deleted.`);
        setDeleteTargetId(null);
        if (selectedStudent?.student_id === studentId) {
          setSelectedStudent(null);
        }
        fetchStudents();
      } else {
        showToast("Failed to delete student.", "error");
      }
    } catch {
      showToast("Error connecting to server.", "error");
    }
  };

  // Filtered students
  const filteredStudents = students.filter(s => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      s.student_id.toLowerCase().includes(q) ||
      (s.student_name && s.student_name.toLowerCase().includes(q)) ||
      (s.department && s.department.toLowerCase().includes(q)) ||
      (s.campus && s.campus.toLowerCase().includes(q))
    );
  });

  const totalCount = students.length;
  const avgCgpa = totalCount > 0 
    ? (students.reduce((acc, s) => acc + (s.overall_cgpa || 0), 0) / totalCount).toFixed(2)
    : "0.00";
  const maxCgpa = totalCount > 0
    ? Math.max(...students.map(s => s.overall_cgpa || 0)).toFixed(2)
    : "0.00";

  // Show loading while NextAuth session is being fetched
  const isSessionLoading = status === "loading";
  const isAuthenticated = !!admin && !!token;

  return (
    <>
      {/* Supabase Dark Studio Background */}
      <main className="min-h-screen bg-[#0f0f0f] text-[#ededed] flex flex-col font-sans selection:bg-[#3ecf8e]/30 selection:text-[#3ecf8e]">
        {/* Toast */}
        {toastMessage && (
          <div className={`fixed top-4 right-4 z-50 px-3.5 py-2.5 rounded-md shadow-2xl border flex items-center space-x-2 text-xs transition-all ${
            toastMessage.type === "success" 
              ? "bg-[#181818] border-[#3ecf8e]/50 text-[#3ecf8e]" 
              : "bg-[#181818] border-red-500/50 text-red-400"
          }`}>
            {toastMessage.type === "success" ? <CheckCircle2 className="w-3.5 h-3.5 text-[#3ecf8e]" /> : <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
            <span className="font-medium text-slate-200">{toastMessage.text}</span>
          </div>
        )}

        {/* Supabase Studio Top Navigation */}
        <header className="border-b border-[#232323] bg-[#141414] sticky top-0 z-30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Link 
                href="/" 
                className="p-1.5 rounded-md text-[#888888] hover:text-[#ededed] hover:bg-[#1f1f1f] transition-colors"
                title="Back to Student Portal"
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div className="flex items-center space-x-2 border-l border-[#262626] pl-3">
                <div className="w-5 h-5 flex items-center justify-center text-[#3ecf8e]">
                  <Database className="w-4 h-4" />
                </div>
                <span className="text-xs font-semibold tracking-wide text-white">
                  DIU Portal <span className="text-[#666666]">/</span> <span className="text-[#3ecf8e]">Admin</span>
                </span>
              </div>
            </div>

            {isAuthenticated && (
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-2 bg-[#1a1a1a] border border-[#2b2b2b] px-2.5 py-1 rounded-md">
                  {admin.picture ? (
                    <img src={admin.picture} alt={admin.name} className="w-5 h-5 rounded-full" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-[#262626] text-[#3ecf8e] flex items-center justify-center text-[10px] font-mono">
                      {admin.name.charAt(0)}
                    </div>
                  )}
                  <span className="text-xs text-[#a3a3a3] font-mono">{admin.email}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center space-x-1 text-xs text-[#888888] hover:text-red-400 hover:bg-[#1a1a1a] border border-transparent hover:border-[#2b2b2b] px-2.5 py-1 rounded-md transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
          {!isAuthenticated ? (
            /* Supabase Dark Login Card */
            <div className="max-w-sm mx-auto mt-20 bg-[#161616] border border-[#262626] rounded-xl p-8 shadow-2xl text-center">
              <div className="w-10 h-10 rounded-lg bg-[#3ecf8e]/10 border border-[#3ecf8e]/20 flex items-center justify-center mx-auto mb-4 text-[#3ecf8e]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <h2 className="text-base font-semibold text-white mb-6">Admin Sign In</h2>

              {authError && (
                <div className="mb-5 p-2.5 rounded-md bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-center space-x-2 text-left">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                  <span>{authError}</span>
                </div>
              )}

              {isLoadingAuth || isSessionLoading ? (
                <div className="py-6 flex flex-col items-center justify-center space-y-2 text-[#888888] text-xs">
                  <Loader2 className="w-5 h-5 animate-spin text-[#3ecf8e]" />
                  <span>Verifying admin privileges...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center space-y-3">
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    className="w-full flex items-center justify-center space-x-3 bg-[#1c1c1c] hover:bg-[#242424] text-white border border-[#2e2e2e] hover:border-[#3e3e3e] px-4 py-2.5 rounded-lg text-sm font-medium transition-all shadow-sm active:scale-[0.99] cursor-pointer"
                  >
                    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>Sign in with Google</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* Supabase Studio Admin Dashboard */
            <div className="space-y-6">
              {/* Navigation Tabs */}
              <div className="flex items-center space-x-1 border-b border-[#232323] pb-px">
                <button
                  type="button"
                  onClick={() => setActiveTab("database")}
                  className={`px-3.5 py-2 text-xs font-mono font-medium flex items-center space-x-2 border-b-2 transition-all cursor-pointer ${
                    activeTab === "database"
                      ? "border-[#3ecf8e] text-white bg-[#1c1c1c]/50 rounded-t-md"
                      : "border-transparent text-[#777777] hover:text-[#cccccc]"
                  }`}
                >
                  <Database className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  <span>Student Records ({totalCount})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("settings")}
                  className={`px-3.5 py-2 text-xs font-mono font-medium flex items-center space-x-2 border-b-2 transition-all cursor-pointer ${
                    activeTab === "settings"
                      ? "border-[#3ecf8e] text-white bg-[#1c1c1c]/50 rounded-t-md"
                      : "border-transparent text-[#777777] hover:text-[#cccccc]"
                  }`}
                >
                  <Settings className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  <span>System Settings</span>
                  {!publicSearchEnabled && (
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="Public searches disabled" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("scrape")}
                  className={`px-3.5 py-2 text-xs font-mono font-medium flex items-center space-x-2 border-b-2 transition-all cursor-pointer ${
                    activeTab === "scrape"
                      ? "border-[#3ecf8e] text-white bg-[#1c1c1c]/50 rounded-t-md"
                      : "border-transparent text-[#777777] hover:text-[#cccccc]"
                  }`}
                >
                  <Play className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  <span>Direct Scrape Tool</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("queue")}
                  className={`px-3.5 py-2 text-xs font-mono font-medium flex items-center space-x-2 border-b-2 transition-all cursor-pointer ${
                    activeTab === "queue"
                      ? "border-[#3ecf8e] text-white bg-[#1c1c1c]/50 rounded-t-md"
                      : "border-transparent text-[#777777] hover:text-[#cccccc]"
                  }`}
                >
                  <ListOrdered className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  <span>Queue Manager</span>
                  {queueData && (queueData.waiting_count > 0 || queueData.active_count > 0) && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#3ecf8e]/10 text-[#3ecf8e] border border-[#3ecf8e]/30 font-mono">
                      {queueData.active_count + queueData.waiting_count}
                    </span>
                  )}
                </button>
              </div>

              {activeTab === "database" && (
                <div className="space-y-6">
                  {/* Stats Overview */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                      <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                        <span>Cached Students</span>
                        <Users className="w-3.5 h-3.5 text-[#3ecf8e]" />
                      </div>
                      <div className="text-2xl font-bold font-mono text-white">{totalCount}</div>
                    </div>

                <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                  <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                    <span>Average CGPA</span>
                    <Award className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#3ecf8e]">{avgCgpa}</div>
                </div>

                <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                  <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                    <span>Highest CGPA</span>
                    <GraduationCap className="w-3.5 h-3.5 text-[#3ecf8e]" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-white">{maxCgpa}</div>
                </div>
              </div>

              {/* Table Toolbar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#161616] border border-[#242424] px-4 py-3 rounded-lg">
                <div className="relative w-full sm:w-80">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#666666]" />
                  <input
                    type="text"
                    placeholder="Search student ID, name, dept..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-[#111111] border border-[#2b2b2b] rounded-md pl-8 pr-7 py-1.5 text-xs text-white placeholder-[#555555] focus:outline-none focus:border-[#3ecf8e] transition-colors font-mono"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2 top-2 text-[#666666] hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <button
                  onClick={fetchStudents}
                  disabled={isLoadingStudents}
                  className="px-3 py-1.5 bg-[#1f1f1f] hover:bg-[#282828] border border-[#333333] text-[#cccccc] rounded-md text-xs font-medium flex items-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isLoadingStudents ? "animate-spin" : ""}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {/* Supabase-Style Data Table */}
              <div className="bg-[#141414] border border-[#242424] rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#181818] text-[#888888] uppercase tracking-wider text-[10px] border-b border-[#242424] font-mono">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Student ID</th>
                        <th className="px-4 py-3 font-semibold">Name</th>
                        <th className="px-4 py-3 font-semibold">Dept</th>
                        <th className="px-4 py-3 font-semibold">Campus</th>
                        <th className="px-4 py-3 font-semibold text-center">CGPA</th>
                        <th className="px-4 py-3 font-semibold text-center">Earned Cr.</th>
                        <th className="px-4 py-3 font-semibold">Last Updated</th>
                        <th className="px-4 py-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1f1f1f] text-[#d4d4d4]">
                      {isLoadingStudents ? (
                        <tr>
                          <td colSpan={8} className="py-12 text-center text-[#666666] text-xs font-mono">
                            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-[#3ecf8e]" />
                            Loading records from Supabase...
                          </td>
                        </tr>
                      ) : filteredStudents.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-10 text-center text-[#666666] text-xs font-mono">
                            {searchQuery ? "No matching records found." : "No student results in database yet."}
                          </td>
                        </tr>
                      ) : (
                        filteredStudents.map((s) => {
                          const formattedDate = s.last_fetched_at
                            ? new Date(s.last_fetched_at).toLocaleString([], {
                                dateStyle: "short",
                                timeStyle: "short"
                              })
                            : "Never";

                          return (
                            <tr key={s.student_id} className="hover:bg-[#1a1a1a] transition-colors">
                              <td className="px-4 py-3 font-mono font-medium text-[#3ecf8e]">
                                {s.student_id}
                              </td>
                              <td className="px-4 py-3 text-white font-medium">
                                {s.student_name || "—"}
                              </td>
                              <td className="px-4 py-3 text-[#999999] font-mono">{s.department || "CSE"}</td>
                              <td className="px-4 py-3 text-[#999999] font-mono">{s.campus || "DSC"}</td>
                              <td className="px-4 py-3 text-center">
                                <span className="inline-block px-2 py-0.5 rounded text-xs font-mono font-bold bg-[#3ecf8e]/10 text-[#3ecf8e] border border-[#3ecf8e]/20">
                                  {Number(s.overall_cgpa || 0).toFixed(2)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center font-mono text-[#cccccc]">
                                {s.completed_credits || 0}
                              </td>
                              <td className="px-4 py-3 text-[#777777] font-mono text-[11px] whitespace-nowrap">
                                <div className="flex items-center space-x-1.5">
                                  <Clock className="w-3 h-3 text-[#555555]" />
                                  <span>{formattedDate}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right whitespace-nowrap">
                                <div className="flex items-center justify-end space-x-1.5">
                                  {/* Inspect */}
                                  <button
                                    onClick={() => handleInspect(s.student_id)}
                                    className="p-1 rounded text-[#888888] hover:text-[#3ecf8e] hover:bg-[#242424] transition-colors"
                                    title="Inspect Transcript"
                                  >
                                    <Eye className="w-4 h-4" />
                                  </button>

                                  {/* Reset Cache */}
                                  <button
                                    onClick={() => handleResetCache(s.student_id)}
                                    className="p-1 rounded text-[#888888] hover:text-amber-400 hover:bg-[#242424] transition-colors"
                                    title="Reset Cache (Force portal scrape on next login)"
                                  >
                                    <RotateCcw className="w-4 h-4" />
                                  </button>

                                  {/* Delete */}
                                  <button
                                    onClick={() => setDeleteTargetId(s.student_id)}
                                    className="p-1 rounded text-[#888888] hover:text-red-400 hover:bg-[#242424] transition-colors"
                                    title="Delete Record"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

            {/* System Settings Tab */}
            {activeTab === "settings" && (
              <div className="space-y-6 max-w-3xl">
                <div className="bg-[#161616] border border-[#242424] rounded-xl p-6 space-y-6">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Settings className="w-4 h-4 text-[#3ecf8e]" />
                      System Settings & Controls
                    </h3>
                    <p className="text-xs text-[#777777] mt-1">
                      Configure cache duration timers and public student search availability.
                    </p>
                  </div>

                  <div className="border-t border-[#232323] pt-5 space-y-6">
                    {/* Stealth Public Kill Switch */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-[#141414] border border-[#242424]">
                      <div className="space-y-1 pr-4">
                        <div className="flex items-center space-x-2">
                          <Power className={`w-4 h-4 ${publicSearchEnabled ? "text-[#3ecf8e]" : "text-amber-400"}`} />
                          <span className="text-xs font-semibold text-white">Public Student Searches</span>
                          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                            publicSearchEnabled 
                              ? "bg-[#3ecf8e]/10 text-[#3ecf8e] border-[#3ecf8e]/30" 
                              : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                          }`}>
                            {publicSearchEnabled ? "ACTIVE" : "DISABLED (STEALTH)"}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#777777] leading-relaxed">
                          When disabled, regular students cannot search results on the public portal. They receive a standard connection error with <strong>no admin banners or indicators</strong>. Only logged-in administrators can search using the Direct Scrape Tool.
                        </p>
                      </div>

                      <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={publicSearchEnabled}
                          onChange={(e) => setPublicSearchEnabled(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-[#262626] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#3ecf8e]"></div>
                      </label>
                    </div>

                    {/* Cache Expiration Timer */}
                    <div className="space-y-3 p-4 rounded-lg bg-[#141414] border border-[#242424]">
                      <div>
                        <div className="flex items-center space-x-2">
                          <Clock className="w-4 h-4 text-[#3ecf8e]" />
                          <span className="text-xs font-semibold text-white">Cache Expiration Timer</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#3ecf8e]/10 text-[#3ecf8e] border border-[#3ecf8e]/20">
                            {cacheTtlMinutes >= 1440 
                              ? `${(cacheTtlMinutes / 1440).toFixed(1)} Days`
                              : cacheTtlMinutes >= 60 
                              ? `${(cacheTtlMinutes / 60).toFixed(1)} Hours`
                              : `${cacheTtlMinutes} Mins`}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#777777] mt-1 leading-relaxed">
                          Once a student's result is cached in Supabase, subsequent searches return instantly without launching a browser. After this timer expires, the next search automatically performs a fresh live scrape from the DIU portal.
                        </p>
                      </div>

                      {/* Preset Buttons */}
                      <div className="flex flex-wrap gap-2 pt-2">
                        {[
                          { label: "30 Minutes", val: 30 },
                          { label: "1 Hour (Default)", val: 60 },
                          { label: "6 Hours", val: 360 },
                          { label: "24 Hours (1 Day)", val: 1440 },
                          { label: "7 Days", val: 10080 },
                        ].map((preset) => (
                          <button
                            key={preset.val}
                            type="button"
                            onClick={() => setCacheTtlMinutes(preset.val)}
                            className={`px-3 py-1.5 rounded text-xs font-mono transition-colors border cursor-pointer ${
                              cacheTtlMinutes === preset.val
                                ? "bg-[#3ecf8e]/20 border-[#3ecf8e] text-[#3ecf8e] font-semibold"
                                : "bg-[#1b1b1b] border-[#292929] text-[#888888] hover:text-white hover:bg-[#242424]"
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>

                      {/* Custom Input */}
                      <div className="pt-2 flex items-center space-x-3">
                        <span className="text-xs text-[#888888] font-mono">Custom minutes:</span>
                        <input
                          type="number"
                          min={1}
                          max={525600}
                          value={cacheTtlMinutes}
                          onChange={(e) => setCacheTtlMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-28 bg-[#111111] border border-[#2b2b2b] rounded px-3 py-1 text-xs text-white font-mono focus:outline-none focus:border-[#3ecf8e]"
                        />
                      </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        onClick={handleSaveSettings}
                        disabled={isSavingSettings}
                        className="px-4 py-2 bg-[#3ecf8e] hover:bg-[#34b27b] text-black font-semibold rounded-lg text-xs flex items-center space-x-2 transition-all shadow-md active:scale-95 disabled:opacity-60 cursor-pointer"
                      >
                        {isSavingSettings ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        <span>{isSavingSettings ? "Saving Settings..." : "Save Settings"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Direct Scrape Tool Tab */}
            {activeTab === "scrape" && (
              <div className="space-y-6 max-w-xl">
                <div className="bg-[#161616] border border-[#242424] rounded-xl p-6 space-y-5">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Play className="w-4 h-4 text-[#3ecf8e]" />
                      Admin Direct Scrape Tool
                    </h3>
                    <p className="text-xs text-[#777777] mt-1 leading-relaxed">
                      Perform live portal scrapes directly as an administrator. This tool completely bypasses the public search kill switch and saves the results directly into the database.
                    </p>
                  </div>

                  {scrapeError && (
                    <div className="p-3 rounded-md bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-center space-x-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                      <span>{scrapeError}</span>
                    </div>
                  )}

                  <form onSubmit={handleAdminScrape} className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                      <label className="text-xs font-mono text-[#888888]">Student ID</label>
                      <input
                        type="text"
                        placeholder="e.g. xxx-xx-xxx"
                        value={scrapeStudentId}
                        onChange={(e) => setScrapeStudentId(e.target.value)}
                        disabled={isScrapingAdmin}
                        required
                        className="w-full bg-[#111111] border border-[#2b2b2b] rounded-lg px-3.5 py-2 text-xs text-white font-mono placeholder-[#555555] focus:outline-none focus:border-[#3ecf8e]"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-mono text-[#888888]">Student Password</label>
                      <input
                        type="password"
                        placeholder="Portal Password"
                        value={scrapePassword}
                        onChange={(e) => setScrapePassword(e.target.value)}
                        disabled={isScrapingAdmin}
                        required
                        className="w-full bg-[#111111] border border-[#2b2b2b] rounded-lg px-3.5 py-2 text-xs text-white font-mono placeholder-[#555555] focus:outline-none focus:border-[#3ecf8e]"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isScrapingAdmin}
                      className="w-full py-2.5 bg-[#3ecf8e] hover:bg-[#34b27b] text-black font-semibold rounded-lg text-xs flex items-center justify-center space-x-2 transition-all shadow-md active:scale-[0.99] disabled:opacity-60 cursor-pointer"
                    >
                      {isScrapingAdmin ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-black" />
                          <span>{scrapeProgressMsg}</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4" />
                          <span>Fetch & Save Results</span>
                        </>
                      )}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* Scraper Queue Manager Tab */}
            {activeTab === "queue" && (
              <div className="space-y-6">
                {/* Header & Controls */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#161616] border border-[#242424] p-5 rounded-xl">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <ListOrdered className="w-4 h-4 text-[#3ecf8e]" />
                      Scraper Concurrency & Queue Manager
                    </h3>
                    <p className="text-xs text-[#777777] mt-1 leading-relaxed">
                      Monitor active headless browser workers, inspect students waiting in line, or cancel/clear requests.
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => fetchQueue()}
                      disabled={isLoadingQueue || isActionQueueLoading}
                      className="px-3 py-1.5 bg-[#1b1b1b] hover:bg-[#222222] border border-[#2e2e2e] text-[#cccccc] hover:text-white rounded-lg text-xs font-mono flex items-center space-x-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingQueue ? "animate-spin text-[#3ecf8e]" : ""}`} />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowClearConfirm(true)}
                      disabled={!queueData || queueData.waiting_count === 0 || isActionQueueLoading}
                      className="px-3 py-1.5 bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-300 rounded-lg text-xs font-mono flex items-center space-x-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear Queue ({queueData?.waiting_count || 0})</span>
                    </button>
                  </div>
                </div>

                {/* Queue Summary Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                    <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                      <span>Active Browser Workers</span>
                      <Activity className="w-3.5 h-3.5 text-[#3ecf8e]" />
                    </div>
                    <div className="flex items-baseline space-x-2">
                      <span className="text-2xl font-bold font-mono text-white">
                        {queueData?.active_count || 0}
                      </span>
                      <span className="text-xs font-mono text-[#666666]">
                        / {queueData?.limit || 4} slots
                      </span>
                    </div>
                    {/* Visual worker slots */}
                    <div className="flex items-center space-x-1.5 mt-3">
                      {Array.from({ length: queueData?.limit || 4 }).map((_, i) => (
                        <div
                          key={i}
                          className={`h-2 flex-1 rounded-sm transition-all ${
                            i < (queueData?.active_count || 0)
                              ? "bg-[#3ecf8e] shadow-[0_0_8px_rgba(62,207,142,0.4)]"
                              : "bg-[#252525]"
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                    <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                      <span>Waiting in Queue</span>
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-amber-400">
                      {queueData?.waiting_count || 0}
                    </div>
                    <p className="text-[11px] text-[#666666] font-mono mt-2">
                      {(queueData?.waiting_count || 0) === 0
                        ? "Queue clear — all searches process immediately"
                        : `${queueData?.waiting_count} student(s) waiting in queue`}
                    </p>
                  </div>

                  <div className="bg-[#161616] border border-[#242424] p-4 rounded-lg">
                    <div className="text-[11px] text-[#888888] uppercase font-mono tracking-wider mb-1 flex items-center justify-between">
                      <span>Concurrency Limit</span>
                      <ShieldCheck className="w-3.5 h-3.5 text-[#3ecf8e]" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-[#3ecf8e]">
                      {queueData?.limit || 4} Max
                    </div>
                    <p className="text-[11px] text-[#666666] font-mono mt-2">
                      Backed by 4GB SSD virtual swap memory
                    </p>
                  </div>
                </div>

                {/* Section 1: Active Running Scrapers */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-mono font-semibold text-[#888888] uppercase tracking-wider flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#3ecf8e] animate-pulse" />
                      Active Scraping Tasks ({queueData?.running?.length || 0})
                    </h4>
                  </div>

                  {queueData?.running && queueData.running.length > 0 ? (
                    <div className="bg-[#161616] border border-[#242424] rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-[#1b1b1b] border-b border-[#242424] text-[10px] text-[#888888] uppercase">
                          <tr>
                            <th className="px-4 py-2.5">Student ID</th>
                            <th className="px-4 py-2.5">Status</th>
                            <th className="px-4 py-2.5">Started At</th>
                            <th className="px-4 py-2.5 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#222222]">
                          {queueData.running.map((item) => (
                            <tr key={item.queue_id} className="hover:bg-[#1a1a1a]">
                              <td className="px-4 py-3 font-semibold text-white">
                                {item.student_id}
                              </td>
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-[#3ecf8e]/10 text-[#3ecf8e] border border-[#3ecf8e]/30">
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  Running
                                </span>
                              </td>
                              <td className="px-4 py-3 text-[#888888]">
                                {item.started_at ? new Date(item.started_at).toLocaleTimeString() : "-"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveFromQueue(item.queue_id)}
                                  disabled={isActionQueueLoading}
                                  className="px-2.5 py-1 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-300 hover:text-red-200 text-xs transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  Cancel Scrape
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="bg-[#161616] border border-[#242424] rounded-lg p-6 text-center text-xs text-[#666666] font-mono">
                      No active scrapers currently executing. Browser workers are idle.
                    </div>
                  )}
                </div>

                {/* Section 2: Waiting Queue */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-mono font-semibold text-[#888888] uppercase tracking-wider flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                      Waiting Queue ({queueData?.waiting?.length || 0})
                    </h4>
                  </div>

                  {queueData?.waiting && queueData.waiting.length > 0 ? (
                    <div className="bg-[#161616] border border-[#242424] rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-[#1b1b1b] border-b border-[#242424] text-[10px] text-[#888888] uppercase">
                          <tr>
                            <th className="px-4 py-2.5">Position</th>
                            <th className="px-4 py-2.5">Student ID</th>
                            <th className="px-4 py-2.5">Status</th>
                            <th className="px-4 py-2.5">Queued At</th>
                            <th className="px-4 py-2.5 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#222222]">
                          {queueData.waiting.map((item, index) => (
                            <tr key={item.queue_id} className="hover:bg-[#1a1a1a]">
                              <td className="px-4 py-3 text-amber-400 font-bold">
                                #{index + 1}
                              </td>
                              <td className="px-4 py-3 font-semibold text-white">
                                {item.student_id}
                              </td>
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-amber-950/30 text-amber-400 border border-amber-500/30">
                                  Waiting in Line
                                </span>
                              </td>
                              <td className="px-4 py-3 text-[#888888]">
                                {item.queued_at ? new Date(item.queued_at).toLocaleTimeString() : "-"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveFromQueue(item.queue_id)}
                                  disabled={isActionQueueLoading}
                                  className="px-2.5 py-1 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-300 hover:text-red-200 text-xs transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="bg-[#161616] border border-[#242424] rounded-lg p-6 text-center text-xs text-[#666666] font-mono">
                      Queue is currently empty. Incoming searches start immediately.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        </div>

        {/* Interactive Human-in-the-Loop Turnstile Modal for Admin */}
        {challengeData && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-[#161616] border border-[#2b2b2b] rounded-xl max-w-sm w-full p-6 text-center shadow-2xl space-y-4">
              <div className="w-10 h-10 rounded-full bg-[#3ecf8e]/10 border border-[#3ecf8e]/20 flex items-center justify-center mx-auto text-[#3ecf8e]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Security Verification</h3>
                <p className="text-xs text-[#888888] mt-1">
                  Cloudflare requires verification. Click the box below to complete:
                </p>
              </div>

              <div className="relative inline-block border border-[#2e2e2e] hover:border-[#3ecf8e] rounded-lg overflow-hidden cursor-pointer transition-colors">
                <img
                  src={challengeData.image}
                  alt="Cloudflare Verification"
                  onClick={handleChallengeClick}
                  className="block max-w-full select-none"
                  draggable={false}
                />
                {isClickingChallenge && (
                  <div className="absolute inset-0 bg-black/70 backdrop-blur-[1px] flex items-center justify-center space-x-2 text-[#3ecf8e] text-xs font-mono">
                    <Loader2 className="w-4 h-4 animate-spin text-[#3ecf8e]" />
                    <span>Dispatching click...</span>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-[#666666] font-mono">
                Click inside the checkbox to proceed immediately.
              </p>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deleteTargetId && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-[#161616] border border-[#2b2b2b] rounded-lg max-w-sm w-full p-5 shadow-2xl text-left space-y-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-md bg-red-950/50 border border-red-500/30 text-red-400">
                  <Trash2 className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-semibold text-white">Delete Student Record</h3>
              </div>
              <p className="text-xs text-[#999999] leading-relaxed">
                Are you sure you want to permanently delete record for student <span className="text-[#ededed] font-mono font-semibold">{deleteTargetId}</span>?
              </p>
              <div className="flex items-center space-x-2 pt-2 justify-end">
                <button
                  onClick={() => setDeleteTargetId(null)}
                  className="px-3 py-1.5 rounded-md bg-[#222222] hover:bg-[#2a2a2a] text-[#cccccc] text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deleteTargetId)}
                  className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Clear Queue Confirmation Modal */}
        {showClearConfirm && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-[#161616] border border-[#2b2b2b] rounded-lg max-w-sm w-full p-5 shadow-2xl text-left space-y-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-md bg-red-950/50 border border-red-500/30 text-red-400">
                  <AlertTriangle className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-semibold text-white">Clear Scraper Queue</h3>
              </div>
              <p className="text-xs text-[#999999] leading-relaxed">
                Are you sure you want to cancel and clear all <span className="text-white font-mono font-bold">{queueData?.waiting_count || 0}</span> waiting student requests from the queue?
              </p>
              <div className="flex items-center space-x-2 pt-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={isActionQueueLoading}
                  className="px-3 py-1.5 rounded-md bg-[#222222] hover:bg-[#2a2a2a] text-[#cccccc] text-xs font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleClearQueue}
                  disabled={isActionQueueLoading}
                  className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isActionQueueLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  <span>Clear All Waiting</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Inspect Student Detail Modal */}
        {selectedStudent && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div className="bg-[#141414] border border-[#262626] rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden my-auto">
              {/* Header */}
              <div className="px-5 py-4 border-b border-[#242424] flex items-center justify-between bg-[#181818]">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-md bg-[#3ecf8e]/10 border border-[#3ecf8e]/20 flex items-center justify-center text-[#3ecf8e]">
                    <GraduationCap className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      {selectedStudent.student_name || "Student Transcript"}
                      <span className="text-[11px] font-mono text-[#3ecf8e] bg-[#3ecf8e]/10 px-2 py-0.5 rounded border border-[#3ecf8e]/20">
                        {selectedStudent.student_id}
                      </span>
                    </h3>
                    <p className="text-[11px] text-[#777777] font-mono">
                      {selectedStudent.department} • {selectedStudent.campus} Campus
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedStudent(null)}
                  className="p-1 rounded text-[#777777] hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Body */}
              <div className="p-5 overflow-y-auto space-y-5 flex-1">
                {/* CGPA Stats */}
                <div className="grid grid-cols-3 gap-2 bg-[#191919] border border-[#262626] p-3 rounded-lg text-center font-mono">
                  <div>
                    <div className="text-[10px] text-[#777777] uppercase">Overall CGPA</div>
                    <div className="text-xl font-bold text-[#3ecf8e] mt-0.5">
                      {Number(selectedStudent.overall_cgpa || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="border-x border-[#2b2b2b]">
                    <div className="text-[10px] text-[#777777] uppercase">Total Credits</div>
                    <div className="text-xl font-bold text-white mt-0.5">{selectedStudent.total_credits || 0}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#777777] uppercase">Completed Cr.</div>
                    <div className="text-xl font-bold text-white mt-0.5">{selectedStudent.completed_credits || 0}</div>
                  </div>
                </div>

                {/* Semesters & Courses */}
                <div className="space-y-3">
                  <div className="text-[11px] font-mono font-semibold text-[#888888] uppercase tracking-wider flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-[#3ecf8e]" />
                    Semesters ({selectedStudent.results_json?.semesters?.length || 0})
                  </div>

                  {selectedStudent.results_json?.semesters?.map((sem, idx) => (
                    <div key={idx} className="bg-[#171717] border border-[#262626] rounded-md overflow-hidden">
                      <div className="px-4 py-2.5 bg-[#1b1b1b] border-b border-[#242424] flex items-center justify-between text-xs font-mono">
                        <span className="font-semibold text-white">{sem.name}</span>
                        <div className="flex items-center space-x-3 text-[11px]">
                          <span className="text-[#888888]">Credits: {sem.credits}</span>
                          <span className="text-[#3ecf8e] font-bold">GPA: {Number(sem.gpa || 0).toFixed(2)}</span>
                        </div>
                      </div>

                      {sem.courses && sem.courses.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs font-mono">
                            <thead className="text-[10px] text-[#666666] uppercase bg-[#141414] border-b border-[#222222]">
                              <tr>
                                <th className="px-3.5 py-1.5">Code</th>
                                <th className="px-3.5 py-1.5 font-sans">Course</th>
                                <th className="px-3.5 py-1.5 text-center">Cr.</th>
                                <th className="px-3.5 py-1.5 text-center">Grade</th>
                                <th className="px-3.5 py-1.5 text-center">Point</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#1f1f1f] text-[#cccccc]">
                              {sem.courses.map((c, cIdx) => (
                                <tr key={cIdx} className="hover:bg-[#1a1a1a]">
                                  <td className="px-3.5 py-1.5 text-[#3ecf8e]">{c.code}</td>
                                  <td className="px-3.5 py-1.5 text-white font-sans text-xs">{c.name}</td>
                                  <td className="px-3.5 py-1.5 text-center">{c.credits}</td>
                                  <td className="px-3.5 py-1.5 text-center font-bold">
                                    <span className={c.grade === "F" ? "text-red-400" : "text-[#3ecf8e]"}>
                                      {c.grade}
                                    </span>
                                  </td>
                                  <td className="px-3.5 py-1.5 text-center text-[#999999]">{c.grade_point}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="p-3 text-center text-xs text-[#666666] italic font-mono">
                          No course details recorded.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-3 border-t border-[#242424] bg-[#181818] flex items-center justify-end space-x-2">
                <button
                  onClick={() => handleResetCache(selectedStudent.student_id)}
                  className="px-3 py-1.5 rounded-md bg-[#242424] hover:bg-[#2e2e2e] text-amber-400 border border-amber-500/20 text-xs font-mono transition-colors flex items-center space-x-1.5"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset Cache Timer</span>
                </button>
                <button
                  onClick={() => setSelectedStudent(null)}
                  className="px-4 py-1.5 rounded-md bg-[#242424] hover:bg-[#2c2c2c] text-white text-xs font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
