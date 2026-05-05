<div align="center">
  
# LumaFetch

**Minimal dark desktop app for media fetching, conversion, and Telegram delivery.**

</div>

<br>

<div align="center">
  
## 🌟 What It Does

LumaFetch is an all-in-one media tool that lets you effortlessly download, convert, and manage audio/video from the web or your local machine.

</div>

### 🚀 Key Features

- **Format Conversion:** Convert any local media file to MP3. Supported formats include: `.webm`, `.mp4`, `.mkv`, `.mov`, `.avi`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.opus`, `.aac`, and `.mp3`.
- **Media Downloader:** Download videos and music from social links directly as MP3s.
- **Real Qualities:** Detects and downloads videos at their true, available qualities.
- **Wide Platform Support:** Compatible with YouTube, YouTube Music, TikTok, Instagram, SoundCloud, and hundreds of other services (powered by `yt-dlp`).
- **Telegram Bot Integration:** Run a local Telegram bot to remotely command the app! The bot can send you MP3s, full playlists, and videos right into your chat.
- **Clean Up:** Automatically deletes Telegram temporary files after they are sent to save disk space.
- **Auto-Setup:** Checks for necessary dependencies (`ffmpeg` and `yt-dlp`) on every launch. If they are missing, a handy setup window with an `Install all` button takes care of it for you.
- **Smart Sourcing:** TikTok downloads request the clean source stream when available (Note: DRM-protected media cannot be bypassed).

---

<div align="center">
  
## 🛠️ How To Use

</div>

### 💻 Running the App Locally
To run the project in a development environment:
```powershell
npm install
npm start
```

### 📦 Building the Windows Executable
To package the app into an `.exe` file for Windows:
```powershell
npm run build
```
The resulting `.exe` installer will be located in the `release/` folder.

**Note on assets:**
- The Windows app icon is located at: `electron_app\assets\lumafetch-icon.ico`
- Bundled tool binaries are stored in: `electron_app\vendor`

---

<div align="center">

## 🤖 Telegram Bot Commands

Once your Telegram bot is configured and running, you can use the following commands in your chat:

</div>

- `/start` or `/help` - Shows the command guide.
- `<media link>` - Simply paste a link! Downloads a single supported link as MP3 and sends it back to you.
- `/playlist <playlist link>` - Checks the playlist size, verifies which items can download, then sends the MP3 files one by one.
- `/video <video link>` - Shows the real available video qualities. Reply to it with `/quality 720p` (or any other listed quality) to download it. The bot will download, send it to you, and clean up the local file afterwards.

*⚠️ Disclaimer: Please use only for media you own or have permission to download.*

<div align="center">
  <br>
  Made with ❤️
</div>
