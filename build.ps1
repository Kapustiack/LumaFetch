$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

python -m pip install --upgrade pip
python -m pip install -r requirements.txt

python -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --onefile `
  --name "WebMToMP3Converter" `
  --collect-data "imageio_ffmpeg" `
  --collect-all "yt_dlp" `
  "webm_to_mp3_converter.py"

Write-Host ""
Write-Host "Built: $PSScriptRoot\dist\WebMToMP3Converter.exe"
