"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Script from "next/script";
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
  Database
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://direct-occupational-com-fellowship.trycloudflare.com";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

declare global {
  interface Window {
    google?: any;
  }
}

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

export default function AdminPage() {
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

  const showToast = (text: string, type: "success" | "error" = "success") => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

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
      sessionStorage.setItem("diu_admin_token", authToken);
    } catch (err: any) {
      setAuthError(err.message || "Authentication failed.");
      setAdmin(null);
      setToken("");
      sessionStorage.removeItem("diu_admin_token");
    } finally {
      setIsLoadingAuth(false);
    }
  }, []);

  // Check saved session
  useEffect(() => {
    const savedToken = sessionStorage.getItem("diu_admin_token");
    if (savedToken) {
      verifyAndSetToken(savedToken);
    }
  }, [verifyAndSetToken]);

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

  useEffect(() => {
    if (token) {
      fetchStudents();
    }
  }, [token, fetchStudents]);

  // Handle Google Callback
  const tokenClientRef = useRef<any>(null);

  // Initialize Google OAuth2 Token Client
  const initGoogleAuth = useCallback(() => {
    if (typeof window !== "undefined" && window.google?.accounts?.oauth2 && GOOGLE_CLIENT_ID) {
      try {
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: "openid email profile",
          callback: (response: any) => {
            if (response?.access_token) {
              verifyAndSetToken(response.access_token);
            } else if (response?.error) {
              setAuthError(`Google Sign-In error: ${response.error_description || response.error}`);
            }
          },
        });
      } catch (e) {
        console.error("Error initializing Google Identity Services:", e);
      }
    }
  }, [verifyAndSetToken]);

  useEffect(() => {
    initGoogleAuth();
  }, [initGoogleAuth]);

  const handleGoogleSignIn = () => {
    setAuthError("");
    if (!tokenClientRef.current) {
      if (typeof window !== "undefined" && window.google?.accounts?.oauth2) {
        initGoogleAuth();
      }
    }
    if (tokenClientRef.current) {
      // prompt: 'select_account' forces the Google account chooser to pop up, allowing choice of any account!
      tokenClientRef.current.requestAccessToken({ prompt: "select_account" });
    } else {
      setAuthError("Google Identity service is loading. Please try again in a moment.");
    }
  };

  const handleLogout = () => {
    setToken("");
    setAdmin(null);
    sessionStorage.removeItem("diu_admin_token");
    if (typeof window !== "undefined" && window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
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

  return (
    <>
      <Script 
        src="https://accounts.google.com/gsi/client" 
        strategy="afterInteractive" 
        onLoad={initGoogleAuth}
      />

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

            {admin && (
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
          {!admin ? (
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

              {isLoadingAuth ? (
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

                  <p className="text-[11px] text-[#666666]">
                    Select <span className="text-[#3ecf8e] font-mono">your admin Gmail</span> in the Google chooser
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Supabase Studio Admin Dashboard */
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
        </div>

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
