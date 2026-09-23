# DIU Student Portal Result Scraper & Overall CGPA Calculator

This application allows DIU students to log in and automatically fetch their academic results from the DIU Student Portal, calculate their overall CGPA across all semesters, and display a comprehensive dashboard with GPA trends and course breakdowns.

---

## 🏗️ Project Architecture

- **Frontend**: Next.js 14, Tailwind CSS, Lucide Icons (`/frontend`)
- **Backend**: FastAPI, Playwright (Edge/Chromium automation) (`/backend`)
- **Scraper & Auth**: Automated browser session handling Keycloak OIDC login and Cloudflare Turnstile verification.

---

## 🚀 How to Run

### Step 1: Start Backend
Double-click `start_backend.bat` or run:
```cmd
venv\Scripts\activate
python backend\app.py
```
Backend runs at `http://localhost:8000`.

### Step 2: Start Frontend
Double-click `start_frontend.bat` or run:
```cmd
cd frontend
npm run dev
```
Frontend runs at `http://localhost:3000`.

---

## 📌 Usage Instructions

1. Open `http://localhost:3000` in your web browser.
2. Enter your **DIU Student ID** and **Password**.
3. Click **View Results**.
4. An automated Edge browser window will open pointing to the DIU portal login:
   - When the **Cloudflare Turnstile** checkbox appears ("Verify you are human"), **click it**.
   - The backend script will automatically fill your credentials and complete the sign-in.
   - If a second Turnstile check appears on portal redirect, click it as well.
5. The backend will intercept your authenticated session, fetch the semester results and GPA graph, calculate your overall CGPA, and stream the data right back to your dashboard!
