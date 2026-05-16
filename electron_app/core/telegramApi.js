const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

function apiError(message) {
  const error = new Error(message);
  error.name = 'TelegramApiError';
  return error;
}

class TelegramApi {
  constructor(token) {
    this.token = String(token || '').trim();
    this.host = 'api.telegram.org';
  }

  requestJson(method, fields = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        body.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      const payload = Buffer.from(body.toString());
      const request = https.request({
        hostname: this.host,
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': payload.length,
        },
        timeout: timeoutMs,
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk.toString(); });
        response.on('end', () => {
          try {
            const json = JSON.parse(text);
            if (!json.ok) reject(apiError(json.description || text));
            else resolve(json.result);
          } catch (error) {
            reject(apiError(`Telegram returned invalid JSON: ${error.message}`));
          }
        });
      });
      request.on('timeout', () => {
        request.destroy(apiError('Telegram request timed out'));
      });
      request.on('error', reject);
      request.end(payload);
    });
  }

  getMe() {
    return this.requestJson('getMe');
  }

  getUpdates(offset, timeout = 25) {
    return this.requestJson('getUpdates', {
      ...(offset ? { offset } : {}),
      timeout,
      allowed_updates: ['message', 'callback_query'],
    }, (timeout + 10) * 1000);
  }

  sendMessage(chatId, text, options = {}) {
    return this.requestJson('sendMessage', {
      chat_id: chatId,
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
      ...options,
    });
  }

  async editMessage(chatId, messageId, text, options = {}) {
    try {
      return await this.requestJson('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: String(text).slice(0, 4096),
        disable_web_page_preview: true,
        ...options,
      });
    } catch (error) {
      if (!String(error.message).toLowerCase().includes('message is not modified')) {
        throw error;
      }
      return null;
    }
  }

  answerCallbackQuery(callbackQueryId, text = '') {
    return this.requestJson('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text: String(text).slice(0, 200) } : {}),
    });
  }

  sendAudio(chatId, filePath, fields = {}, onProgress, cancelToken = null) {
    return this.uploadFile('sendAudio', chatId, 'audio', filePath, fields, onProgress, cancelToken);
  }

  sendVideo(chatId, filePath, fields = {}, onProgress, cancelToken = null) {
    return this.uploadFile('sendVideo', chatId, 'video', filePath, fields, onProgress, cancelToken);
  }

  uploadFile(method, chatId, fileField, filePath, fields = {}, onProgress, cancelToken = null) {
    return new Promise((resolve, reject) => {
      const boundary = `----LumaFetch${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const safeName = path.basename(filePath).replace(/["\r\n]/g, ' ');
      const fileSize = fs.statSync(filePath).size;
      const chunks = [];
      const addField = (name, value) => {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      addField('chat_id', chatId);
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) addField(key, String(value));
      }
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + header.length + fileSize + footer.length;

      const request = https.request({
        hostname: this.host,
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
        },
        timeout: 10 * 60 * 1000,
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk.toString(); });
        response.on('end', () => {
          try {
            const json = JSON.parse(text);
            if (!json.ok) reject(apiError(json.description || text));
            else resolve(json.result);
          } catch (error) {
            reject(apiError(`Telegram returned invalid JSON: ${error.message}`));
          }
        });
      });
      request.on('timeout', () => request.destroy(apiError('Telegram upload timed out')));
      request.on('error', reject);

      for (const chunk of chunks) request.write(chunk);
      request.write(header);
      let sent = 0;
      if (onProgress) onProgress(sent, fileSize);
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      const cancelTimer = setInterval(() => {
        if (cancelToken && cancelToken.cancelled) {
          stream.destroy(apiError('Cancelled'));
          request.destroy(apiError('Cancelled'));
        }
      }, 250);
      stream.on('data', (chunk) => {
        sent += chunk.length;
        if (onProgress) onProgress(sent, fileSize);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        request.write(footer);
        request.end();
      });
      request.on('close', () => clearInterval(cancelTimer));
      stream.pipe(request, { end: false });
    });
  }
}

module.exports = {
  TelegramApi,
};
