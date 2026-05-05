@echo off
setlocal
cd /d "%~dp0"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Installation failed. Make sure Python 3.10 or newer is installed.
  pause
  exit /b 1
)
echo.
echo Dependencies installed.
pause
