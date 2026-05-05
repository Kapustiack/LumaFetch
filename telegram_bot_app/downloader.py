from __future__ import annotations

import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


ProgressCallback = Callable[[str, float | None, str], None]


class DownloadCancelled(Exception):
    pass


@dataclass
class MediaDownloadResult:
    file_path: Path
    title: str
    source_url: str


def human_bytes(value: int | float | None) -> str:
    if value is None:
        return ""
    units = ("B", "KB", "MB", "GB")
    amount = float(value)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{amount:.1f} GB"


def human_eta(seconds: int | float | None) -> str:
    if seconds is None:
        return ""
    seconds = int(seconds)
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


def make_temp_download_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="telegram_mp3_bot_"))


def cleanup_path(path: Path) -> None:
    if path.exists():
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def download_url_to_mp3(
    url: str,
    temp_dir: Path,
    ffmpeg_path: str,
    bitrate: str,
    cancel_event: threading.Event,
    progress_callback: ProgressCallback,
) -> MediaDownloadResult:
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError(
            "yt-dlp is not installed. Run install_dependencies.bat, then restart the app."
        ) from exc

    temp_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(temp_dir / "%(title).180B [%(id)s].%(ext)s")

    def on_download_progress(status: dict) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()

        state = status.get("status")
        if state == "downloading":
            downloaded = status.get("downloaded_bytes") or 0
            total = status.get("total_bytes") or status.get("total_bytes_estimate")
            percent = None
            if total:
                percent = max(0.0, min(100.0, downloaded / total * 100))

            parts = []
            if total:
                parts.append(f"{human_bytes(downloaded)} of {human_bytes(total)}")
            else:
                parts.append(human_bytes(downloaded))
            speed = status.get("speed")
            if speed:
                parts.append(f"{human_bytes(speed)}/s")
            eta = status.get("eta")
            if eta is not None:
                parts.append(f"ETA {human_eta(eta)}")
            progress_callback("Downloading", percent, " | ".join(part for part in parts if part))
        elif state == "finished":
            progress_callback("Converting", 100.0, "Download finished")

    def on_postprocessor_progress(status: dict) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()
        postprocessor = status.get("postprocessor") or "ffmpeg"
        state = status.get("status")
        if state == "started":
            progress_callback("Converting", None, f"{postprocessor} started")
        elif state == "finished":
            progress_callback("Converting", 100.0, f"{postprocessor} finished")

    ydl_options = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "ffmpeg_location": ffmpeg_path,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "no_color": True,
        "windowsfilenames": True,
        "retries": 10,
        "fragment_retries": 10,
        "socket_timeout": 25,
        "concurrent_fragment_downloads": 5,
        "progress_hooks": [on_download_progress],
        "postprocessor_hooks": [on_postprocessor_progress],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": bitrate.rstrip("k"),
            }
        ],
    }

    progress_callback("Reading", None, "Checking link")
    with yt_dlp.YoutubeDL(ydl_options) as ydl:
        info = ydl.extract_info(url, download=True)

    if cancel_event.is_set():
        raise DownloadCancelled()

    mp3_files = sorted(temp_dir.rglob("*.mp3"), key=lambda path: path.stat().st_mtime)
    if not mp3_files:
        raise RuntimeError("Could not find the converted MP3 file.")

    title = info.get("title") if isinstance(info, dict) else None
    return MediaDownloadResult(
        file_path=mp3_files[-1],
        title=str(title or mp3_files[-1].stem),
        source_url=url,
    )
