# DIU Student Portal Result Scraper & CGPA Platform

A full-stack, automated platform for Daffodil International University (DIU) students to view their academic transcripts, track running semester GPAs, and calculate their official overall CGPA in real-time.

Built with **Camoufox** (stealth anti-detect browser), **FastAPI**, **Supabase**, and **Next.js 14**.

---

## 🚀 Key Features

* **Headless Stealth Scraper**: Powered by Camoufox (custom Firefox engine) with human mouse kinematics and automatic Turnstile handling.
* **Human-in-the-Loop Relay**: Interactive CAPTCHA challenge relay in modal if strict network verification is required.
* **Transparent 1-Hour Database Caching**: Repeat student logins load instantly in **<200ms** directly from Supabase/SQLite.
* **Google-Authenticated Admin Panel (`/admin`)**:
  * Gated strictly behind Google OAuth with email whitelist (`ADMIN_EMAILS`).
  * Supabase Studio dark theme.
  * Inspect full student transcripts without needing passwords.
  * One-click cache reset to force live portal scrapes.
  * Student record deletion.
* **Progressive Streaming**: Live SSE streaming card-by-card as each semester is loaded.

---

## 🏗️ Project Architecture

* **Frontend**: Next.js 14 (App Router), Tailwind CSS, Lucide Icons (`/frontend`)
* **Backend**: FastAPI, Async Camoufox, Uvicorn (`/backend`)
* **Database**: Supabase Cloud PostgreSQL with automatic local SQLite fallback (`/data`)
* **Deployment**: Docker, Docker Compose, Oracle Cloud Always Free VM, Vercel

---

## 🛠️ Local Development Setup

### 1. Backend Setup
```bash
# Activate virtual environment
venv\Scripts\activate   # Windows
# source venv/bin/activate # Linux/Mac

# Install dependencies
pip install -r backend/requirements.txt
pip install "camoufox[geoip]"

# Run FastAPI backend
python backend/app.py
```
Backend runs at `http://localhost:8000`.

### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at `http://localhost:3000`.

---

## 🌐 Production Deployment

Refer to [**`DEPLOY_ORACLE_CLOUD.md`**](./DEPLOY_ORACLE_CLOUD.md) for full instructions on hosting:
* **Backend:** Oracle Cloud Always Free VM (12GB RAM, 100% Free Forever)
* **Frontend:** Vercel (Next.js)
* **Database:** Supabase Cloud
