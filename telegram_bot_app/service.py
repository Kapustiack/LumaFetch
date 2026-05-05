from __future__ import annotations

import queue
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .downloader import (
    DownloadCancelled,
    cleanup_path,
    download_url_to_mp3,
    human_bytes,
    make_temp_download_dir,
)
from .telegram_api import TelegramApi, TelegramApiError


URL_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)


EventSink = Callable[[tuple], None]


@dataclass
class BotDownloadJob:
    job_id: str
    chat_id: int
    url: str
    progress_message_id: int


def extract_urls(text: str) -> list[str]:
    urls = []
    for match in URL_RE.findall(text or ""):
        urls.append(match.rstrip(".,;:!?)\"]'"))
    return urls


def clean_title(title: str) -> str:
    compact = " ".join(title.split())
    return compact[:96] if compact else "audio"


class TelegramBotService:
    def __init__(
        self,
        token: str,
        ffmpeg_path: str,
        bitrate: str,
        max_file_mb: int,
        lock_to_first_chat: bool,
        event_sink: EventSink,
    ) -> None:
        self.api = TelegramApi(token)
        self.ffmpeg_path = ffmpeg_path
        self.bitrate = bitrate
        self.max_file_mb = max(1, max_file_mb)
        self.lock_to_first_chat = lock_to_first_chat
        self.event_sink = event_sink

        self.cancel_event = threading.Event()
        self.jobs: queue.Queue[BotDownloadJob | None] = queue.Queue()
        self.poll_thread: threading.Thread | None = None
        self.worker_thread: threading.Thread | None = None
        self.allowed_chat_id: int | None = None
        self.username = ""

    def start(self) -> str:
        me = self.api.get_me()
        self.username = me.get("username") or me.get("first_name") or "bot"
        self.cancel_event.clear()
        self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.poll_thread.start()
        self.worker_thread.start()
        self.event_sink(("bot_status", f"Connected as @{self.username}"))
        return self.username

    def stop(self) -> None:
        self.cancel_event.set()
        self.jobs.put(None)
        self.event_sink(("bot_status", "Disconnecting bot..."))

    def _poll_loop(self) -> None:
        offset: int | None = None
        while not self.cancel_event.is_set():
            try:
                updates = self.api.get_updates(offset, timeout_seconds=20)
                for update in updates:
                    offset = int(update["update_id"]) + 1
                    self._handle_update(update)
            except TelegramApiError as exc:
                if not self.cancel_event.is_set():
                    self.event_sink(("bot_status", f"Telegram polling error: {exc}"))
                    time.sleep(5)
            except Exception as exc:
                if not self.cancel_event.is_set():
                    self.event_sink(("bot_status", f"Bot error: {exc}"))
                    time.sleep(5)
        self.event_sink(("bot_status", "Bot polling stopped."))

    def _handle_update(self, update: dict) -> None:
        message = update.get("message") or {}
        text = message.get("text") or message.get("caption") or ""
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return

        if self.lock_to_first_chat:
            if self.allowed_chat_id is None:
                self.allowed_chat_id = int(chat_id)
                self.event_sink(("bot_allowed_chat", str(self.allowed_chat_id)))
            elif int(chat_id) != self.allowed_chat_id:
                self.api.send_message(
                    chat_id,
                    "This bot is locked to another chat. Disconnect and reconnect in the desktop app to reset it.",
                )
                return

        if text.strip().lower().startswith("/start"):
            self.api.send_message(
                chat_id,
                "Send a YouTube, YouTube Music, or other supported media link. "
                "Use this only for media you own or have permission to download.",
            )
            return

        urls = extract_urls(text)
        if not urls:
            self.api.send_message(chat_id, "Send me a media link and I will return an MP3.")
            return

        for url in urls:
            progress_message = self.api.send_message(chat_id, f"Queued:\n{url}")
            job = BotDownloadJob(
                job_id=uuid.uuid4().hex,
                chat_id=int(chat_id),
                url=url,
                progress_message_id=int(progress_message["message_id"]),
            )
            self.jobs.put(job)
            self.event_sink(("bot_job_queued", job.job_id, str(chat_id), url, "Queued"))

    def _worker_loop(self) -> None:
        while not self.cancel_event.is_set():
            job = self.jobs.get()
            if job is None:
                break
            self._process_job(job)
        self.event_sink(("bot_status", "Bot worker stopped."))

    def _process_job(self, job: BotDownloadJob) -> None:
        temp_dir = make_temp_download_dir()
        last_edit = 0.0
        last_text = ""

        def update_chat(text: str, force: bool = False) -> None:
            nonlocal last_edit, last_text
            now = time.monotonic()
            if not force and (now - last_edit < 1.5 or text == last_text):
                return
            try:
                self.api.edit_message(job.chat_id, job.progress_message_id, text)
                last_edit = now
                last_text = text
            except TelegramApiError as exc:
                self.event_sink(("bot_status", f"Could not edit Telegram progress: {exc}"))

        def on_progress(stage: str, percent: float | None, detail: str) -> None:
            if percent is None:
                text = f"{stage}...\n{detail}\n{job.url}"
                gui_status = f"{stage}: {detail}"
            else:
                text = f"{stage}: {percent:.1f}%\n{detail}\n{job.url}"
                gui_status = f"{stage} {percent:.1f}%"
            update_chat(text)
            self.event_sink(("bot_job_update", job.job_id, gui_status))

        try:
            update_chat(f"Starting...\n{job.url}", force=True)
            self.event_sink(("bot_job_update", job.job_id, "Starting"))
            result = download_url_to_mp3(
                job.url,
                temp_dir,
                self.ffmpeg_path,
                self.bitrate,
                self.cancel_event,
                on_progress,
            )

            title = clean_title(result.title)
            size_bytes = result.file_path.stat().st_size
            max_bytes = self.max_file_mb * 1024 * 1024
            if size_bytes > max_bytes:
                raise RuntimeError(
                    f"MP3 is {human_bytes(size_bytes)}, over the {self.max_file_mb} MB limit."
                )

            update_chat(
                f"Sending MP3...\n{title}\nSize: {human_bytes(size_bytes)}",
                force=True,
            )
            self.event_sink(("bot_job_update", job.job_id, "Sending MP3"))

            def on_upload_progress(sent_bytes: int, total_bytes: int) -> None:
                if not total_bytes:
                    return
                percent = max(0.0, min(100.0, sent_bytes / total_bytes * 100))
                update_chat(
                    f"Sending MP3: {percent:.1f}%\n{title}\n{human_bytes(sent_bytes)} of {human_bytes(total_bytes)}"
                )
                self.event_sink(("bot_job_update", job.job_id, f"Sending {percent:.1f}%"))

            self.api.send_audio(
                job.chat_id,
                result.file_path,
                title=title,
                caption=f"{title}\n\nSource: {job.url}",
                progress_callback=on_upload_progress,
            )
            update_chat("Sent successfully. Local downloaded file deleted.", force=True)
            self.event_sink(("bot_job_update", job.job_id, "Sent and deleted local file"))
        except DownloadCancelled:
            update_chat("Cancelled.", force=True)
            self.event_sink(("bot_job_update", job.job_id, "Cancelled"))
        except Exception as exc:
            message = str(exc)
            if "drm" in message.lower():
                message = "This link appears to be protected and cannot be downloaded."
            update_chat(f"Failed:\n{message}", force=True)
            self.event_sink(("bot_job_update", job.job_id, f"Failed: {message}"))
        finally:
            cleanup_path(temp_dir)
