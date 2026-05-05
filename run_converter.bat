@echo off
setlocal
cd /d "%~dp0"
python -c "import imageio_ffmpeg" >nul 2>nul
if errorlevel 1 (
  echo Installing required dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo Could not install dependencies.
    pause
    exit /b 1
  )
)
python webm_to_mp3_converter.py
