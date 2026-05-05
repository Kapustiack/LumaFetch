from __future__ import annotations

import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
import tkinter as tk

from telegram_bot_app.service import TelegramBotService
from telegram_bot_app.downloader import (
    cleanup_path,
    download_url_to_mp3,
    make_temp_download_dir,
)


APP_NAME = "WebM to MP3 Converter"
SUPPORTED_SUFFIX = ".webm"
DURATION_RE = re.compile(r"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)")
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@dataclass
class ConversionJob:
    source: Path
    source_root: Path | None = None
    output: Path | None = None
    item_id: str = ""


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def normalized_path(path: Path) -> str:
    try:
        return os.path.normcase(str(path.resolve()))
    except OSError:
        return os.path.normcase(str(path.absolute()))


def parse_clock_seconds(value: str) -> float | None:
    match = re.match(r"(?P<h>\d+):(?P<m>\d+):(?P<s>\d+(?:\.\d+)?)", value.strip())
    if not match:
        return None
    return (
        int(match.group("h")) * 3600
        + int(match.group("m")) * 60
        + float(match.group("s"))
    )


def find_ffmpeg() -> str:
    local_candidates = [
        app_dir() / "ffmpeg.exe",
        app_dir() / "bin" / "ffmpeg.exe",
    ]
    for candidate in local_candidates:
        if candidate.exists():
            return str(candidate)

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass

    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg

    raise RuntimeError(
        "ffmpeg was not found. Run install_dependencies.bat, or build the EXE with build.ps1."
    )


def probe_duration(ffmpeg_path: str, input_path: Path) -> float | None:
    try:
        completed = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-i", str(input_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=CREATE_NO_WINDOW,
        )
    except (subprocess.SubprocessError, OSError):
        return None

    text = f"{completed.stdout}\n{completed.stderr}"
    match = DURATION_RE.search(text)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def progress_seconds_from_line(line: str) -> float | None:
    if "=" not in line:
        return None
    key, value = line.strip().split("=", 1)
    if key in {"out_time_ms", "out_time_us"}:
        try:
            return int(value) / 1_000_000
        except ValueError:
            return None
    if key == "out_time":
        return parse_clock_seconds(value)
    return None


def safe_print(message: str) -> None:
    try:
        if sys.stdout:
            print(message)
    except OSError:
        pass


def convert_file(
    ffmpeg_path: str,
    input_path: Path,
    output_path: Path,
    bitrate: str,
    overwrite: bool,
    duration_seconds: float | None,
    cancel_event: threading.Event,
    progress_callback,
) -> tuple[bool, str]:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-y" if overwrite else "-n",
        "-i",
        str(input_path),
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        "-progress",
        "pipe:1",
        "-nostats",
        str(output_path),
    ]

    log_tail: list[str] = []
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError as exc:
        return False, f"Could not start ffmpeg: {exc}"

    assert process.stdout is not None
    for line in process.stdout:
        if cancel_event.is_set():
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            return False, "Cancelled"

        clean = line.strip()
        if clean:
            log_tail.append(clean)
            if len(log_tail) > 30:
                del log_tail[: len(log_tail) - 30]

        seconds = progress_seconds_from_line(line)
        if seconds is not None and duration_seconds and duration_seconds > 0:
            percent = max(0.0, min(100.0, (seconds / duration_seconds) * 100))
            progress_callback(percent)

    return_code = process.wait()
    if cancel_event.is_set():
        return False, "Cancelled"
    if return_code == 0:
        progress_callback(100.0)
        return True, "Done"

    useful_lines = [line for line in log_tail if "progress=" not in line]
    detail = useful_lines[-1] if useful_lines else f"ffmpeg exited with code {return_code}"
    return False, detail


def self_test(log_path: Path | None = None) -> int:
    def log(message: str) -> None:
        safe_print(message)
        if log_path:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log_file:
                log_file.write(message + "\n")

    temp_dir = Path(tempfile.mkdtemp(prefix="webm_to_mp3_converter_"))
    source = temp_dir / "sample.webm"
    output = temp_dir / "sample.mp3"
    try:
        ffmpeg_path = find_ffmpeg()
        log(f"ffmpeg: {ffmpeg_path}")
        subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:a",
                "libopus",
                str(source),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
        duration = probe_duration(ffmpeg_path, source)
        ok, detail = convert_file(
            ffmpeg_path,
            source,
            output,
            "192k",
            True,
            duration,
            threading.Event(),
            lambda _percent: None,
        )
        if not ok or not output.exists() or output.stat().st_size == 0:
            log(f"Self-test failed: {detail}")
            return 1
        log(f"Self-test passed: {output}")
        return 0
    except Exception as exc:
        log(f"Self-test failed: {exc}")
        log(traceback.format_exc())
        return 1


def bot_downloader_self_test(log_path: Path | None = None) -> int:
    def log(message: str) -> None:
        safe_print(message)
        if log_path:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log_file:
                log_file.write(message + "\n")

    source_dir = Path(tempfile.mkdtemp(prefix="telegram_bot_source_"))
    download_dir = make_temp_download_dir()
    source = source_dir / "sample.webm"
    server: ThreadingHTTPServer | None = None
    try:
        ffmpeg_path = find_ffmpeg()
        subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=554:duration=1",
                "-c:a",
                "libopus",
                str(source),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(source_dir), **kwargs)

            def log_message(self, format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/sample.webm"
        progress_events: list[tuple[str, float | None, str]] = []
        result = download_url_to_mp3(
            url,
            download_dir,
            ffmpeg_path,
            "192k",
            threading.Event(),
            lambda stage, percent, detail: progress_events.append((stage, percent, detail)),
        )
        if not result.file_path.exists() or result.file_path.stat().st_size == 0:
            log("Bot downloader self-test failed: no MP3 output.")
            return 1
        log(
            "Bot downloader self-test passed: "
            f"{result.file_path.name}, {len(progress_events)} progress events."
        )
        return 0
    except Exception as exc:
        log(f"Bot downloader self-test failed: {exc}")
        log(traceback.format_exc())
        return 1
    finally:
        if server:
            server.shutdown()
        cleanup_path(download_dir)
        cleanup_path(source_dir)


class ConverterApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_NAME)
        self.root.geometry("980x680")
        self.root.minsize(820, 560)

        self.jobs: list[ConversionJob] = []
        self.known_sources: set[str] = set()
        self.events: queue.Queue[tuple] = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.running = False
        self.bot_service: TelegramBotService | None = None
        self.bot_activity_items: dict[str, str] = {}

        self.output_folder_var = tk.StringVar()
        self.recursive_var = tk.BooleanVar(value=True)
        self.overwrite_var = tk.BooleanVar(value=False)
        self.bitrate_var = tk.StringVar(value="192k")
        self.status_var = tk.StringVar(value="Add WebM files or choose a folder to begin.")
        self.current_file_var = tk.StringVar(value="No file running")
        self.bot_token_var = tk.StringVar()
        self.bot_bitrate_var = tk.StringVar(value="192k")
        self.bot_max_mb_var = tk.IntVar(value=50)
        self.bot_lock_first_chat_var = tk.BooleanVar(value=True)
        self.bot_status_var = tk.StringVar(value="Disconnected.")
        self.bot_allowed_chat_var = tk.StringVar(value="Not locked")

        self._configure_style()
        self._build_ui()
        self._poll_events()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _configure_style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TButton", padding=(10, 6))
        style.configure("Accent.TButton", padding=(12, 7), font=("Segoe UI", 10, "bold"))
        style.configure("Header.TLabel", font=("Segoe UI", 18, "bold"))
        style.configure("Subtle.TLabel", foreground="#555555")
        style.configure("Treeview", rowheight=28)
        style.configure("Horizontal.TProgressbar", thickness=14)

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)

        self.notebook = ttk.Notebook(self.root)
        self.notebook.grid(row=0, column=0, sticky="nsew")

        converter_tab = ttk.Frame(self.notebook, padding=16)
        telegram_tab = ttk.Frame(self.notebook, padding=16)
        self.notebook.add(converter_tab, text="WebM Batch Converter")
        self.notebook.add(telegram_tab, text="Telegram Bot")

        outer = converter_tab
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(3, weight=1)

        ttk.Label(outer, text=APP_NAME, style="Header.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            outer,
            text="Batch convert WebM videos into MP3 audio, one file at a time.",
            style="Subtle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 14))

        toolbar = ttk.Frame(outer)
        toolbar.grid(row=2, column=0, sticky="ew", pady=(0, 12))
        toolbar.columnconfigure(8, weight=1)

        self.add_files_btn = ttk.Button(toolbar, text="Add Files", command=self.add_files)
        self.add_files_btn.grid(row=0, column=0, padx=(0, 8))
        self.add_folder_btn = ttk.Button(
            toolbar, text="Add Folder", command=self.add_folder
        )
        self.add_folder_btn.grid(row=0, column=1, padx=(0, 8))
        self.remove_btn = ttk.Button(
            toolbar, text="Remove Selected", command=self.remove_selected
        )
        self.remove_btn.grid(row=0, column=2, padx=(0, 8))
        self.clear_btn = ttk.Button(toolbar, text="Clear", command=self.clear_queue)
        self.clear_btn.grid(row=0, column=3, padx=(0, 16))

        ttk.Checkbutton(
            toolbar, text="Include subfolders", variable=self.recursive_var
        ).grid(row=0, column=4, padx=(0, 12))
        ttk.Checkbutton(
            toolbar, text="Overwrite existing MP3s", variable=self.overwrite_var
        ).grid(row=0, column=5, padx=(0, 12))

        ttk.Label(toolbar, text="Quality").grid(row=0, column=6, padx=(0, 6))
        self.quality_box = ttk.Combobox(
            toolbar,
            textvariable=self.bitrate_var,
            state="readonly",
            width=8,
            values=("128k", "192k", "256k", "320k"),
        )
        self.quality_box.grid(row=0, column=7, padx=(0, 8))

        queue_frame = ttk.LabelFrame(outer, text="Queue", padding=10)
        queue_frame.grid(row=3, column=0, sticky="nsew")
        queue_frame.columnconfigure(0, weight=1)
        queue_frame.rowconfigure(0, weight=1)

        columns = ("source", "status", "output")
        self.tree = ttk.Treeview(
            queue_frame,
            columns=columns,
            show="headings",
            selectmode="extended",
        )
        self.tree.heading("source", text="Source WebM")
        self.tree.heading("status", text="Status")
        self.tree.heading("output", text="Output MP3")
        self.tree.column("source", width=360, minwidth=200)
        self.tree.column("status", width=130, minwidth=110, anchor="center")
        self.tree.column("output", width=360, minwidth=200)
        self.tree.grid(row=0, column=0, sticky="nsew")

        y_scroll = ttk.Scrollbar(queue_frame, orient="vertical", command=self.tree.yview)
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll = ttk.Scrollbar(queue_frame, orient="horizontal", command=self.tree.xview)
        x_scroll.grid(row=1, column=0, sticky="ew")
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        options = ttk.LabelFrame(outer, text="Output", padding=10)
        options.grid(row=4, column=0, sticky="ew", pady=(12, 0))
        options.columnconfigure(1, weight=1)

        ttk.Label(options, text="Folder").grid(row=0, column=0, sticky="w", padx=(0, 8))
        output_entry = ttk.Entry(options, textvariable=self.output_folder_var)
        output_entry.grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Button(options, text="Browse", command=self.choose_output_folder).grid(
            row=0, column=2, padx=(0, 8)
        )
        self.open_output_btn = ttk.Button(
            options, text="Open Folder", command=self.open_output_folder
        )
        self.open_output_btn.grid(row=0, column=3)

        progress = ttk.LabelFrame(outer, text="Progress", padding=10)
        progress.grid(row=5, column=0, sticky="ew", pady=(12, 0))
        progress.columnconfigure(1, weight=1)

        ttk.Label(progress, text="Current").grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.current_progress = ttk.Progressbar(
            progress, orient="horizontal", mode="determinate", maximum=100
        )
        self.current_progress.grid(row=0, column=1, sticky="ew")
        ttk.Label(progress, textvariable=self.current_file_var, style="Subtle.TLabel").grid(
            row=1, column=1, sticky="w", pady=(4, 8)
        )

        ttk.Label(progress, text="Overall").grid(row=2, column=0, sticky="w", padx=(0, 8))
        self.overall_progress = ttk.Progressbar(
            progress, orient="horizontal", mode="determinate", maximum=100
        )
        self.overall_progress.grid(row=2, column=1, sticky="ew")
        ttk.Label(progress, textvariable=self.status_var, style="Subtle.TLabel").grid(
            row=3, column=1, sticky="w", pady=(4, 0)
        )

        actions = ttk.Frame(outer)
        actions.grid(row=6, column=0, sticky="ew", pady=(12, 0))
        actions.columnconfigure(0, weight=1)

        self.cancel_btn = ttk.Button(actions, text="Cancel", command=self.cancel)
        self.cancel_btn.grid(row=0, column=1, padx=(0, 8))
        self.start_btn = ttk.Button(
            actions, text="Start Convert", style="Accent.TButton", command=self.start
        )
        self.start_btn.grid(row=0, column=2)
        self.cancel_btn.state(["disabled"])
        self._build_telegram_tab(telegram_tab)

    def _build_telegram_tab(self, tab: ttk.Frame) -> None:
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(4, weight=1)

        ttk.Label(tab, text="Telegram Bot", style="Header.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            tab,
            text="Connect a bot token, send it a supported media link, and it will return an MP3.",
            style="Subtle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 14))

        settings = ttk.LabelFrame(tab, text="Bot Settings", padding=10)
        settings.grid(row=2, column=0, sticky="ew")
        settings.columnconfigure(1, weight=1)

        ttk.Label(settings, text="Bot token").grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.bot_token_entry = ttk.Entry(settings, textvariable=self.bot_token_var, show="*")
        self.bot_token_entry.grid(row=0, column=1, sticky="ew", padx=(0, 8))
        self.bot_connect_btn = ttk.Button(
            settings, text="Connect", style="Accent.TButton", command=self.connect_bot
        )
        self.bot_connect_btn.grid(row=0, column=2, padx=(0, 8))
        self.bot_disconnect_btn = ttk.Button(
            settings, text="Disconnect", command=self.disconnect_bot
        )
        self.bot_disconnect_btn.grid(row=0, column=3)
        self.bot_disconnect_btn.state(["disabled"])

        ttk.Label(settings, text="MP3 quality").grid(
            row=1, column=0, sticky="w", padx=(0, 8), pady=(10, 0)
        )
        self.bot_quality_box = ttk.Combobox(
            settings,
            textvariable=self.bot_bitrate_var,
            state="readonly",
            width=8,
            values=("128k", "192k", "256k", "320k"),
        )
        self.bot_quality_box.grid(row=1, column=1, sticky="w", pady=(10, 0))

        limit_frame = ttk.Frame(settings)
        limit_frame.grid(row=1, column=2, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Label(limit_frame, text="Max send size MB").grid(row=0, column=0, padx=(0, 8))
        self.bot_max_size_spinner = ttk.Spinbox(
            limit_frame,
            from_=1,
            to=2000,
            increment=5,
            width=8,
            textvariable=self.bot_max_mb_var,
        )
        self.bot_max_size_spinner.grid(row=0, column=1)

        self.bot_lock_check = ttk.Checkbutton(
            settings,
            text="Lock to first Telegram chat",
            variable=self.bot_lock_first_chat_var,
        )
        self.bot_lock_check.grid(row=2, column=1, sticky="w", pady=(10, 0))

        status = ttk.LabelFrame(tab, text="Connection", padding=10)
        status.grid(row=3, column=0, sticky="ew", pady=(12, 0))
        status.columnconfigure(1, weight=1)
        ttk.Label(status, text="Status").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Label(status, textvariable=self.bot_status_var, style="Subtle.TLabel").grid(
            row=0, column=1, sticky="w"
        )
        ttk.Label(status, text="Chat").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(6, 0))
        ttk.Label(status, textvariable=self.bot_allowed_chat_var, style="Subtle.TLabel").grid(
            row=1, column=1, sticky="w", pady=(6, 0)
        )

        activity_frame = ttk.LabelFrame(tab, text="Bot Activity", padding=10)
        activity_frame.grid(row=4, column=0, sticky="nsew", pady=(12, 0))
        activity_frame.columnconfigure(0, weight=1)
        activity_frame.rowconfigure(0, weight=1)

        columns = ("time", "chat", "url", "status")
        self.bot_tree = ttk.Treeview(
            activity_frame,
            columns=columns,
            show="headings",
            selectmode="browse",
        )
        self.bot_tree.heading("time", text="Time")
        self.bot_tree.heading("chat", text="Chat")
        self.bot_tree.heading("url", text="Link")
        self.bot_tree.heading("status", text="Status")
        self.bot_tree.column("time", width=80, minwidth=70, anchor="center")
        self.bot_tree.column("chat", width=120, minwidth=90, anchor="center")
        self.bot_tree.column("url", width=430, minwidth=220)
        self.bot_tree.column("status", width=230, minwidth=160)
        self.bot_tree.grid(row=0, column=0, sticky="nsew")

        y_scroll = ttk.Scrollbar(activity_frame, orient="vertical", command=self.bot_tree.yview)
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll = ttk.Scrollbar(activity_frame, orient="horizontal", command=self.bot_tree.xview)
        x_scroll.grid(row=1, column=0, sticky="ew")
        self.bot_tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

    def connect_bot(self) -> None:
        if self.bot_service is not None:
            return
        token = self.bot_token_var.get().strip()
        if not token:
            messagebox.showinfo(APP_NAME, "Enter your Telegram bot token first.")
            return

        try:
            ffmpeg_path = find_ffmpeg()
        except RuntimeError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return

        try:
            max_file_mb = int(self.bot_max_mb_var.get())
        except (TypeError, ValueError):
            max_file_mb = 50
            self.bot_max_mb_var.set(max_file_mb)

        service = TelegramBotService(
            token=token,
            ffmpeg_path=ffmpeg_path,
            bitrate=self.bot_bitrate_var.get(),
            max_file_mb=max_file_mb,
            lock_to_first_chat=self.bot_lock_first_chat_var.get(),
            event_sink=self.events.put,
        )
        self.bot_service = service
        self.bot_status_var.set("Connecting...")
        self._set_bot_controls(connecting=True)
        threading.Thread(
            target=self._start_bot_service,
            args=(service,),
            daemon=True,
        ).start()

    def _start_bot_service(self, service: TelegramBotService) -> None:
        try:
            username = service.start()
            self.events.put(("bot_connected", username))
        except Exception as exc:
            self.events.put(("bot_connect_failed", str(exc)))

    def disconnect_bot(self) -> None:
        if self.bot_service is None:
            return
        self.bot_service.stop()
        self.bot_service = None
        self.bot_allowed_chat_var.set("Not locked")
        self.bot_status_var.set("Disconnected.")
        self._set_bot_controls(connecting=False)

    def _set_bot_controls(self, connecting: bool = False, connected: bool | None = None) -> None:
        is_connected = self.bot_service is not None if connected is None else connected
        lock_inputs = connecting or is_connected
        for widget in (
            self.bot_token_entry,
            self.bot_quality_box,
            self.bot_max_size_spinner,
            self.bot_lock_check,
        ):
            widget.state(["disabled"] if lock_inputs else ["!disabled"])
        self.bot_connect_btn.state(["disabled"] if lock_inputs else ["!disabled"])
        self.bot_disconnect_btn.state(["!disabled"] if is_connected and not connecting else ["disabled"])

    def on_close(self) -> None:
        if self.bot_service is not None:
            self.bot_service.stop()
            self.bot_service = None
        if self.running:
            self.cancel_event.set()
        self.root.destroy()

    def add_files(self) -> None:
        if self.running:
            return
        paths = filedialog.askopenfilenames(
            title="Choose WebM files",
            filetypes=(("WebM files", "*.webm"), ("All files", "*.*")),
        )
        if not paths:
            return
        files = [Path(path) for path in paths if Path(path).suffix.lower() == SUPPORTED_SUFFIX]
        skipped = len(paths) - len(files)
        added = self._add_jobs(files)
        self._set_added_status(added, skipped)

    def add_folder(self) -> None:
        if self.running:
            return
        folder_text = filedialog.askdirectory(title="Choose a folder containing WebM files")
        if not folder_text:
            return
        folder = Path(folder_text)
        files = self._find_webm_files(folder, self.recursive_var.get())
        added = self._add_jobs(files, source_root=folder)
        if not files:
            messagebox.showinfo(APP_NAME, "No .webm files were found in that folder.")
        self._set_added_status(added, 0)

    def _find_webm_files(self, folder: Path, recursive: bool) -> list[Path]:
        iterator = folder.rglob("*") if recursive else folder.glob("*")
        files = [
            path
            for path in iterator
            if path.is_file() and path.suffix.lower() == SUPPORTED_SUFFIX
        ]
        return sorted(files, key=lambda path: str(path).lower())

    def _add_jobs(
        self, files: list[Path], source_root: Path | None = None
    ) -> int:
        added = 0
        root = source_root.resolve() if source_root else None
        for file_path in files:
            source = file_path.resolve()
            key = normalized_path(source)
            if key in self.known_sources:
                continue
            job = ConversionJob(source=source, source_root=root)
            item_id = self.tree.insert(
                "",
                "end",
                values=(str(source), "Waiting", ""),
            )
            job.item_id = item_id
            self.jobs.append(job)
            self.known_sources.add(key)
            added += 1
        return added

    def _set_added_status(self, added: int, skipped: int) -> None:
        parts = []
        if added:
            parts.append(f"Added {added} file{'s' if added != 1 else ''}.")
        if skipped:
            parts.append(f"Skipped {skipped} non-WebM file{'s' if skipped != 1 else ''}.")
        if not parts:
            parts.append("No new WebM files were added.")
        self.status_var.set(" ".join(parts))

    def remove_selected(self) -> None:
        if self.running:
            return
        selected = set(self.tree.selection())
        if not selected:
            return
        kept: list[ConversionJob] = []
        for job in self.jobs:
            if job.item_id in selected:
                self.tree.delete(job.item_id)
                self.known_sources.discard(normalized_path(job.source))
            else:
                kept.append(job)
        self.jobs = kept
        self.status_var.set(f"Removed {len(selected)} selected file{'s' if len(selected) != 1 else ''}.")

    def clear_queue(self) -> None:
        if self.running:
            return
        self.tree.delete(*self.tree.get_children())
        self.jobs.clear()
        self.known_sources.clear()
        self.current_progress["value"] = 0
        self.overall_progress["value"] = 0
        self.current_file_var.set("No file running")
        self.status_var.set("Queue cleared.")

    def choose_output_folder(self) -> None:
        folder = filedialog.askdirectory(title="Choose output folder")
        if folder:
            self.output_folder_var.set(folder)

    def open_output_folder(self) -> None:
        folder_text = self.output_folder_var.get().strip()
        if not folder_text:
            messagebox.showinfo(APP_NAME, "Choose an output folder first.")
            return
        folder = Path(folder_text)
        folder.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(folder)
        except OSError as exc:
            messagebox.showerror(APP_NAME, f"Could not open folder:\n{exc}")

    def start(self) -> None:
        if self.running:
            return
        if not self.jobs:
            messagebox.showinfo(APP_NAME, "Add at least one WebM file first.")
            return

        output_folder_text = self.output_folder_var.get().strip()
        if not output_folder_text:
            messagebox.showinfo(APP_NAME, "Choose an output folder first.")
            return

        output_folder = Path(output_folder_text)
        try:
            output_folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            messagebox.showerror(APP_NAME, f"Could not create output folder:\n{exc}")
            return

        try:
            ffmpeg_path = find_ffmpeg()
        except RuntimeError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return

        self._plan_outputs(output_folder)
        self.cancel_event.clear()
        self.running = True
        self._set_controls_running(True)
        self.current_progress["value"] = 0
        self.overall_progress["value"] = 0
        self.status_var.set("Starting conversion...")

        jobs_snapshot = list(self.jobs)
        self.worker = threading.Thread(
            target=self._run_worker,
            args=(
                ffmpeg_path,
                jobs_snapshot,
                self.bitrate_var.get(),
                self.overwrite_var.get(),
            ),
            daemon=True,
        )
        self.worker.start()

    def _target_for_job(self, job: ConversionJob, output_folder: Path) -> Path:
        if job.source_root:
            try:
                relative = job.source.relative_to(job.source_root).with_suffix(".mp3")
                return output_folder / relative
            except ValueError:
                pass
        return output_folder / f"{job.source.stem}.mp3"

    def _unique_target(
        self,
        target: Path,
        planned: set[str],
        avoid_existing: bool,
    ) -> Path:
        if normalized_path(target) not in planned and (not avoid_existing or not target.exists()):
            return target

        parent = target.parent
        stem = target.stem
        suffix = target.suffix
        counter = 2
        while True:
            candidate = parent / f"{stem} ({counter}){suffix}"
            if normalized_path(candidate) not in planned and (
                not avoid_existing or not candidate.exists()
            ):
                return candidate
            counter += 1

    def _plan_outputs(self, output_folder: Path) -> None:
        planned: set[str] = set()
        avoid_existing = not self.overwrite_var.get()
        for job in self.jobs:
            target = self._target_for_job(job, output_folder)
            target = self._unique_target(target, planned, avoid_existing)
            planned.add(normalized_path(target))
            job.output = target
            self.tree.set(job.item_id, "status", "Waiting")
            self.tree.set(job.item_id, "output", str(target))

    def cancel(self) -> None:
        if not self.running:
            return
        self.cancel_event.set()
        self.status_var.set("Cancelling after the current ffmpeg step stops...")
        self.cancel_btn.state(["disabled"])

    def _set_controls_running(self, running: bool) -> None:
        widgets = [
            self.add_files_btn,
            self.add_folder_btn,
            self.remove_btn,
            self.clear_btn,
            self.start_btn,
            self.quality_box,
        ]
        for widget in widgets:
            widget.state(["disabled"] if running else ["!disabled"])
        self.cancel_btn.state(["!disabled"] if running else ["disabled"])

    def _run_worker(
        self,
        ffmpeg_path: str,
        jobs: list[ConversionJob],
        bitrate: str,
        overwrite: bool,
    ) -> None:
        total = len(jobs)
        failures = 0
        processed = 0
        cancelled = False

        for index, job in enumerate(jobs):
            if self.cancel_event.is_set():
                cancelled = True
                self._mark_remaining_cancelled(jobs[index:])
                break

            assert job.output is not None
            self.events.put(("status", job.item_id, "Reading", str(job.output)))
            self.events.put(
                (
                    "current",
                    f"{index + 1}/{total}: {job.source.name}",
                    (processed / total) * 100,
                )
            )
            duration = probe_duration(ffmpeg_path, job.source)

            self.events.put(("status", job.item_id, "Converting", str(job.output)))

            def on_progress(percent: float) -> None:
                overall = ((index + percent / 100) / total) * 100
                self.events.put(("progress", job.item_id, percent, overall))

            ok, detail = convert_file(
                ffmpeg_path,
                job.source,
                job.output,
                bitrate,
                overwrite,
                duration,
                self.cancel_event,
                on_progress,
            )

            if self.cancel_event.is_set():
                cancelled = True
                self.events.put(("status", job.item_id, "Cancelled", str(job.output)))
                self._mark_remaining_cancelled(jobs[index + 1 :])
                break

            processed += 1
            if ok:
                self.events.put(("status", job.item_id, "Done", str(job.output)))
                self.events.put(("message", f"Converted {job.source.name}"))
            else:
                failures += 1
                self.events.put(("status", job.item_id, f"Failed: {detail}", str(job.output)))
                self.events.put(("message", f"Failed: {job.source.name}"))

            self.events.put(("progress", job.item_id, 100.0, (processed / total) * 100))

        self.events.put(("finished", cancelled, failures, processed, total))

    def _mark_remaining_cancelled(self, jobs: list[ConversionJob]) -> None:
        for job in jobs:
            self.events.put(
                (
                    "status",
                    job.item_id,
                    "Cancelled",
                    str(job.output) if job.output else "",
                )
            )

    def _poll_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                self._handle_event(event)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def _handle_event(self, event: tuple) -> None:
        event_type = event[0]
        if event_type == "status":
            _, item_id, status, output = event
            self.tree.set(item_id, "status", status)
            self.tree.set(item_id, "output", output)
        elif event_type == "current":
            _, label, overall = event
            self.current_file_var.set(label)
            self.current_progress["value"] = 0
            self.overall_progress["value"] = overall
        elif event_type == "progress":
            _, _item_id, current_percent, overall_percent = event
            self.current_progress["value"] = current_percent
            self.overall_progress["value"] = overall_percent
        elif event_type == "message":
            _, message = event
            self.status_var.set(message)
        elif event_type == "finished":
            _, cancelled, failures, processed, total = event
            self.running = False
            self._set_controls_running(False)
            if cancelled:
                self.status_var.set(
                    f"Cancelled. Processed {processed} of {total}; {failures} failed."
                )
            elif failures:
                self.status_var.set(
                    f"Finished with {failures} failed file{'s' if failures != 1 else ''}."
                )
                self.overall_progress["value"] = 100
            else:
                self.status_var.set(f"Done. Converted {processed} file{'s' if processed != 1 else ''}.")
                self.current_progress["value"] = 100 if processed else 0
                self.overall_progress["value"] = 100 if total else 0
            self.current_file_var.set("No file running")
        elif event_type == "bot_status":
            _, message = event
            self.bot_status_var.set(message)
        elif event_type == "bot_connected":
            _, username = event
            self.bot_status_var.set(f"Connected as @{username}")
            self._set_bot_controls(connecting=False, connected=True)
        elif event_type == "bot_connect_failed":
            _, message = event
            self.bot_service = None
            self.bot_status_var.set(f"Connection failed: {message}")
            self._set_bot_controls(connecting=False, connected=False)
        elif event_type == "bot_allowed_chat":
            _, chat_id = event
            self.bot_allowed_chat_var.set(chat_id)
        elif event_type == "bot_job_queued":
            _, job_id, chat_id, url, status = event
            item_id = self.bot_tree.insert(
                "",
                0,
                values=(time.strftime("%H:%M:%S"), chat_id, url, status),
            )
            self.bot_activity_items[job_id] = item_id
        elif event_type == "bot_job_update":
            _, job_id, status = event
            item_id = self.bot_activity_items.get(job_id)
            if item_id:
                self.bot_tree.set(item_id, "status", status)


def main() -> None:
    log_path = None
    for index, argument in enumerate(sys.argv):
        if argument == "--self-test-log" and index + 1 < len(sys.argv):
            log_path = Path(sys.argv[index + 1])
            break
    if "--self-test" in sys.argv:
        raise SystemExit(self_test(log_path))
    if "--bot-downloader-self-test" in sys.argv:
        raise SystemExit(bot_downloader_self_test(log_path))

    root = tk.Tk()
    ConverterApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
