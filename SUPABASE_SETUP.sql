-- ========================================================
-- DIU CGPA Calculator - Supabase Database Schema
-- Run this in your Supabase Project -> SQL Editor
-- ========================================================

-- 1. Create the student_results table
CREATE TABLE IF NOT EXISTS public.student_results (
    student_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    student_name TEXT,
    department TEXT,
    campus TEXT,
    overall_cgpa NUMERIC(4, 2),
    total_credits NUMERIC(6, 1),
    completed_credits NUMERIC(6, 1),
    results_json JSONB NOT NULL,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create index on last_fetched_at for fast queries
CREATE INDEX IF NOT EXISTS idx_student_results_fetched 
ON public.student_results (last_fetched_at DESC);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.student_results ENABLE ROW LEVEL SECURITY;

-- 4. Policy: Allow service role (backend API) full access
CREATE POLICY "Allow service role full access" 
ON public.student_results
FOR ALL 
TO service_role
USING (true)
WITH CHECK (true);
