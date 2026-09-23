@echo off
echo ========================================================
echo Starting DIU CGPA Calculator Backend (FastAPI)...
echo ========================================================
cd /d "%~dp0"
venv\Scripts\python.exe backend\app.py
pause
