from __future__ import annotations

import http.client
import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable


class TelegramApiError(Exception):
    pass


class TelegramApi:
    def __init__(self, token: str) -> None:
        self.token = token.strip()
        self.base_url = f"https://api.telegram.org/bot{self.token}"

    def _url(self, method: str) -> str:
        return f"{self.base_url}/{method}"

    def call_json(
        self,
        method: str,
        data: dict[str, Any] | None = None,
        timeout: int = 30,
    ) -> dict[str, Any]:
        encoded = urllib.parse.urlencode(data or {}).encode("utf-8")
        request = urllib.request.Request(self._url(method), data=encoded, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise TelegramApiError(f"Telegram HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise TelegramApiError(f"Telegram request failed: {exc}") from exc

        if not payload.get("ok"):
            description = payload.get("description", "Unknown Telegram API error")
            raise TelegramApiError(str(description))
        return payload

    def get_me(self) -> dict[str, Any]:
        return self.call_json("getMe")["result"]

    def get_updates(self, offset: int | None, timeout_seconds: int = 25) -> list[dict[str, Any]]:
        data: dict[str, Any] = {
            "timeout": timeout_seconds,
            "allowed_updates": json.dumps(["message"]),
        }
        if offset is not None:
            data["offset"] = offset
        return self.call_json("getUpdates", data, timeout=timeout_seconds + 10)["result"]

    def send_message(self, chat_id: int | str, text: str) -> dict[str, Any]:
        return self.call_json(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text[:4096],
                "disable_web_page_preview": "true",
            },
        )["result"]

    def edit_message(self, chat_id: int | str, message_id: int, text: str) -> None:
        try:
            self.call_json(
                "editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": text[:4096],
                    "disable_web_page_preview": "true",
                },
            )
        except TelegramApiError as exc:
            if "message is not modified" not in str(exc).lower():
                raise

    def send_audio(
        self,
        chat_id: int | str,
        audio_path: Path,
        title: str,
        caption: str,
        timeout: int = 300,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        fields = {
            "chat_id": str(chat_id),
            "title": title[:64],
            "caption": caption[:1024],
        }
        return self._stream_multipart(
            "sendAudio",
            fields,
            "audio",
            audio_path,
            timeout,
            progress_callback,
        )["result"]

    def _stream_multipart(
        self,
        method: str,
        fields: dict[str, str],
        file_field: str,
        file_path: Path,
        timeout: int,
        progress_callback: Callable[[int, int], None] | None,
    ) -> dict[str, Any]:
        boundary = f"----CodexTelegramBoundary{uuid.uuid4().hex}"
        file_name = file_path.name.replace('"', "'").replace("\r", " ").replace("\n", " ")
        mime_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"

        chunks: list[bytes] = []
        for name, value in fields.items():
            chunks.append(f"--{boundary}\r\n".encode("utf-8"))
            chunks.append(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
            )
            chunks.append(str(value).encode("utf-8"))
            chunks.append(b"\r\n")

        file_header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{file_name}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode("utf-8")
        file_footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
        file_size = os.path.getsize(file_path)
        content_length = (
            sum(len(chunk) for chunk in chunks)
            + len(file_header)
            + file_size
            + len(file_footer)
        )

        connection = http.client.HTTPSConnection("api.telegram.org", timeout=timeout)
        try:
            connection.putrequest("POST", f"/bot{self.token}/{method}")
            connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            connection.putheader("Content-Length", str(content_length))
            connection.endheaders()
            for chunk in chunks:
                connection.send(chunk)
            connection.send(file_header)
            uploaded = 0
            if progress_callback:
                progress_callback(uploaded, file_size)
            with file_path.open("rb") as audio:
                while True:
                    data = audio.read(1024 * 1024)
                    if not data:
                        break
                    connection.send(data)
                    uploaded += len(data)
                    if progress_callback:
                        progress_callback(uploaded, file_size)
            connection.send(file_footer)

            response = connection.getresponse()
            payload_text = response.read().decode("utf-8", errors="replace")
        finally:
            connection.close()

        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError as exc:
            raise TelegramApiError(f"Telegram returned invalid JSON: {payload_text[:300]}") from exc

        if response.status >= 400 or not payload.get("ok"):
            description = payload.get("description", payload_text[:300])
            raise TelegramApiError(f"Telegram upload failed: {description}")
        return payload
