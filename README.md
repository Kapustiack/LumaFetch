# LumaFetch

Minimal Windows media desk for converting local files, fetching web media, and relaying downloads through a Telegram bot.

![LumaFetch overview](docs/screenshots/app-overview.svg)

## Highlights

- Convert local media files to MP3 with batch progress.
- Drop files or whole folders into Studio.
- Paste one link or many links into Fetch and run them as a queue.
- Download audio from YouTube, YouTube Music, TikTok, Instagram, SoundCloud, and other yt-dlp supported sites.
- Download videos with real available quality selection after analysis.
- Run a Telegram bot that sends MP3/MP4 files back to your chat and deletes local temporary files after upload.
- Telegram supports `/start`, `/help`, `/status`, `/pause`, `/resume`, `/cancel`, `/playlist <link>`, `/video <link>`, and plain links for MP3.
- Telegram queue messages include pause/resume/cancel controls, and failed items can be retried from a button.
- Settings persist theme, output folder, default quality, Telegram limits, cookies browser, and update preference.
- Dependency setup checks ffmpeg and yt-dlp on launch and can install missing tools.
- Temporary LumaFetch download folders are cleaned automatically on startup and manually from Settings.

## Screenshots And Demo Assets

Store public screenshots and GIFs in `docs/screenshots/`:

- `app-overview.svg` is a lightweight visual preview committed with the repo.
- Recommended release screenshots: Studio batch conversion, Fetch queue, Relay bot controls, Settings diagnostics.
- Recommended GIFs: drag-drop conversion, Telegram playlist queue, update check.

## Development

```powershell
npm install
npm start
```

## Build

```powershell
npm run build
```

The Windows installer is written to `release/`. Do not commit installers or build output to the source repo.

## GitHub Releases And Updates

LumaFetch is configured for GitHub Releases through `electron-updater`.

1. Build the installer.
2. Create a GitHub release such as `v0.4.0`.
3. Upload the generated installer and update metadata from `release/`.
4. Installed builds can check for updates from Settings.

## Code Signing

Unsigned Windows installers work, but Windows SmartScreen may warn new users. For a public release, use a real code signing certificate and configure Electron Builder with:

```powershell
$env:CSC_LINK="C:\path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD="certificate-password"
npm run build
```

Keep certificate files and passwords out of git. After signing, test the installer on a clean Windows user account before publishing.

## Telegram Bot

Create a bot with BotFather, paste the token into Relay, optionally save it, then click Connect.

Commands:

- `/start` or `/help` shows the guide.
- Plain media link sends MP3.
- `/playlist <link>` queues every item and asks for format and quality with buttons.
- `/video <link>` asks for MP3/MP4 and real video qualities with buttons.
- `/status` shows pause, resume, and cancel buttons.
- `/pause`, `/resume`, and `/cancel` control the queue.

For YouTube sign-in or bot verification errors, set a cookies browser in Settings so yt-dlp can use your browser session.

## Legal

Use LumaFetch only for media you own, have permission to download, or are legally allowed to archive. DRM-protected media is not supported.
