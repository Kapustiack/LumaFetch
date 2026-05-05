const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { TelegramApi } = require('./telegramApi');
const {
  analyzeVideo,
  getPlaylistFlat,
  downloadAudio,
  downloadVideo,
} = require('./ytdlp');
const { createCancelToken, requestCancel } = require('./cancel');
const { ensureDir } = require('./media');

const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const AUDIO_QUALITIES = ['128k', '192k', '256k', '320k'];
const PLAYLIST_VIDEO_QUALITIES = ['best', '1080p', '720p', '480p', '360p'];

function extractUrls(text) {
  return [...String(text || '').matchAll(URL_RE)].map((match) => match[0].replace(/[.,;:!?)\]"']+$/g, ''));
}

function firstUrl(text) {
  return extractUrls(text)[0] || null;
}

function cleanTitle(value) {
  return String(value || 'media').replace(/\s+/g, ' ').trim().slice(0, 96) || 'media';
}

function commandMatches(text, command) {
  return new RegExp(`^/${command}(?:@[a-z0-9_]+)?(?:\\s|$)`, 'i').test(String(text || '').trim());
}

function matchesAnyCommand(text, commands) {
  return commands.some((command) => commandMatches(text, command));
}

function callbackId() {
  return crypto.randomBytes(5).toString('hex');
}

function callbackData(action, id, value = '') {
  return [action, id, value].filter(Boolean).join(':');
}

function button(text, data) {
  return { text, callback_data: data };
}

function replyMarkup(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function chunkButtons(items, size = 2) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = Number(bytes || 0);
  for (const unit of units) {
    if (amount < 1024 || unit === units[units.length - 1]) {
      return unit === 'B' ? `${Math.round(amount)} B` : `${amount.toFixed(1)} ${unit}`;
    }
    amount /= 1024;
  }
  return `${amount.toFixed(1)} GB`;
}

function helpText() {
  return [
    'Available commands:',
    '',
    '/help - show this guide',
    '/start - show this guide',
    '/cancel - stop the current download and clear queued jobs',
    '',
    'Audio:',
    'Send a link, or use /audio <link>, and I will send back an MP3.',
    'Works with YouTube, YouTube Music, TikTok, Instagram, SoundCloud, and other yt-dlp supported media links.',
    '',
    'Playlist audio:',
    '/playlist <link>',
    'I will read the playlist quickly, ask for format and quality with buttons, then try each item one by one.',
    '',
    'Video:',
    '/video <link>',
    'I will detect the source, ask for MP3 or MP4, then show quality buttons.',
    '',
    'Use only media you own or have permission to download. DRM-protected links cannot be downloaded.',
  ].join('\n');
}

class TelegramBotController {
  constructor({ token, tools, bitrate, maxFileMb, lockFirstChat, sendEvent }) {
    this.api = new TelegramApi(token);
    this.tools = tools;
    this.bitrate = bitrate || '192k';
    this.maxFileMb = Math.max(1, Number(maxFileMb || 50));
    this.lockFirstChat = lockFirstChat;
    this.sendEvent = sendEvent;
    this.cancelToken = { cancelled: false };
    this.jobCancelToken = createCancelToken();
    this.queue = [];
    this.processing = false;
    this.offset = null;
    this.allowedChatId = null;
    this.pendingVideos = new Map();
    this.pendingFlows = new Map();
    this.polling = false;
  }

  async start() {
    const me = await this.api.getMe();
    this.cancelToken.cancelled = false;
    this.polling = true;
    this.pollLoop();
    this.emit({ type: 'status', text: `Connected as @${me.username || me.first_name}` });
    return { username: me.username || me.first_name || 'bot' };
  }

  stop() {
    this.cancelToken.cancelled = true;
    requestCancel(this.jobCancelToken);
    this.polling = false;
    this.emit({ type: 'status', text: 'Disconnected' });
  }

  emit(payload) {
    if (this.sendEvent) this.sendEvent(payload);
  }

  registerFlow(flow) {
    const id = callbackId();
    this.pendingFlows.set(id, {
      ...flow,
      createdAt: Date.now(),
    });
    return id;
  }

  formatKeyboard(id) {
    return replyMarkup([
      [
        button('MP3 audio (default)', callbackData('fmt', id, 'mp3')),
        button('MP4 video', callbackData('fmt', id, 'mp4')),
      ],
      [button('Cancel', callbackData('cancel', id))],
    ]);
  }

  audioQualityKeyboard(id) {
    return replyMarkup([
      AUDIO_QUALITIES.map((quality) => button(quality === this.bitrate ? `${quality} default` : quality, callbackData('aq', id, quality))),
      [button('Cancel', callbackData('cancel', id))],
    ]);
  }

  videoQualityKeyboard(id, qualities) {
    const qualityButtons = (qualities && qualities.length ? qualities : [{ label: 'best' }])
      .map((quality) => button(quality.label, callbackData('vq', id, quality.label)));
    return replyMarkup([
      ...chunkButtons(qualityButtons, 3),
      [button('Cancel', callbackData('cancel', id))],
    ]);
  }

  playlistVideoQualityKeyboard(id) {
    return replyMarkup([
      ...chunkButtons(PLAYLIST_VIDEO_QUALITIES.map((quality) => button(quality, callbackData('vq', id, quality))), 3),
      [button('Cancel', callbackData('cancel', id))],
    ]);
  }

  async pollLoop() {
    while (this.polling && !this.cancelToken.cancelled) {
      try {
        const updates = await this.api.getUpdates(this.offset, 20);
        for (const update of updates) {
          this.offset = Number(update.update_id) + 1;
          if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
          } else {
            await this.handleUpdate(update);
          }
        }
      } catch (error) {
        if (!this.cancelToken.cancelled) {
          this.emit({ type: 'status', text: `Polling error: ${error.message}` });
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }

  async handleUpdate(update) {
    const message = update.message || {};
    const chat = message.chat || {};
    const chatId = chat.id;
    const text = message.text || message.caption || '';
    if (!chatId) return;

    if (this.lockFirstChat) {
      if (!this.allowedChatId) {
        this.allowedChatId = chatId;
        this.emit({ type: 'chat', chatId });
      } else if (chatId !== this.allowedChatId) {
        await this.api.sendMessage(chatId, 'This desktop bot is locked to another chat.');
        return;
      }
    }

    const trimmed = text.trim();
    if (matchesAnyCommand(trimmed, ['start', 'help'])) {
      await this.api.sendMessage(chatId, helpText());
      return;
    }

    if (matchesAnyCommand(trimmed, ['cancel', 'stop'])) {
      this.cancelJobs();
      await this.api.sendMessage(chatId, 'Cancelled current Telegram job and cleared the queue.');
      return;
    }

    if (matchesAnyCommand(trimmed, ['playlist'])) {
      const url = firstUrl(trimmed);
      if (!url) {
        await this.api.sendMessage(chatId, 'Use: /playlist <playlist link>');
        return;
      }
      await this.preparePlaylist(chatId, url);
      return;
    }

    if (matchesAnyCommand(trimmed, ['video'])) {
      const url = firstUrl(trimmed);
      if (!url) {
        await this.api.sendMessage(chatId, 'Use: /video <video link>');
        return;
      }
      await this.prepareVideoFormat(chatId, url);
      return;
    }

    if (matchesAnyCommand(trimmed, ['quality'])) {
      await this.api.sendMessage(chatId, 'Use the buttons under the /video or /playlist message to pick quality.');
      return;
    }

    if (matchesAnyCommand(trimmed, ['audio', 'mp3', 'music'])) {
      const url = firstUrl(trimmed);
      if (!url) {
        await this.api.sendMessage(chatId, 'Use: /audio <media link>');
        return;
      }
      const progress = await this.api.sendMessage(chatId, `Queued MP3...\n${url}`);
      this.enqueue({ type: 'single-audio', chatId, url, messageId: progress.message_id });
      return;
    }

    const urls = extractUrls(trimmed);
    if (!urls.length) {
      await this.api.sendMessage(chatId, helpText());
      return;
    }
    for (const url of urls) {
      const progress = await this.api.sendMessage(chatId, `Queued MP3...\n${url}`);
      this.enqueue({ type: 'single-audio', chatId, url, messageId: progress.message_id });
    }
  }

  async handleCallbackQuery(query) {
    const message = query.message || {};
    const chat = message.chat || {};
    const chatId = chat.id;
    const messageId = message.message_id;
    const data = String(query.data || '');
    if (!chatId || !messageId || !data) return;

    if (this.lockFirstChat && this.allowedChatId && chatId !== this.allowedChatId) {
      await this.api.answerCallbackQuery(query.id, 'This bot is locked to another chat.');
      return;
    }

    const [action, id, ...rest] = data.split(':');
    const value = rest.join(':');
    const flow = this.pendingFlows.get(id);
    if (!flow) {
      await this.api.answerCallbackQuery(query.id, 'This choice is no longer active.');
      return;
    }

    await this.api.answerCallbackQuery(query.id);

    if (action === 'cancel') {
      this.pendingFlows.delete(id);
      await this.api.editMessage(chatId, messageId, 'Cancelled.', { reply_markup: { inline_keyboard: [] } });
      return;
    }

    if (action === 'fmt') {
      flow.format = value;
      this.pendingFlows.set(id, flow);
      if (value === 'mp3') {
        await this.api.editMessage(
          chatId,
          messageId,
          `${flow.kind === 'playlist' ? `Playlist: ${flow.title}` : `Media: ${flow.title}`}\n\nPick MP3 quality:`,
          this.audioQualityKeyboard(id),
        );
        return;
      }

      if (flow.kind === 'playlist') {
        await this.api.editMessage(
          chatId,
          messageId,
          [
            `Playlist: ${flow.title}`,
            `Can download: ${flow.items.length}`,
            '',
            'Pick max MP4 quality. Each item will use the best available stream at or below your choice.',
          ].join('\n'),
          this.playlistVideoQualityKeyboard(id),
        );
        return;
      }

      await this.api.editMessage(
        chatId,
        messageId,
        `Video: ${flow.title}\n\nPick actual available MP4 quality:`,
        this.videoQualityKeyboard(id, flow.qualities),
      );
      return;
    }

    if (action === 'aq') {
      this.pendingFlows.delete(id);
      if (flow.kind === 'playlist') {
        await this.api.editMessage(
          chatId,
          messageId,
          [
            `Queued playlist as MP3.`,
            `Playlist: ${flow.title}`,
            `Items queued: ${flow.items.length}/${flow.total}`,
            `Quality: ${value}`,
            '',
            'I will try each item one by one and skip anything unavailable.',
          ].join('\n'),
          { reply_markup: { inline_keyboard: [] } },
        );
        this.enqueue({ type: 'playlist-audio', chatId, messageId, title: flow.title, items: flow.items, total: flow.total, unavailable: flow.unavailable, bitrate: value });
        return;
      }

      await this.api.editMessage(chatId, messageId, `Queued MP3 ${value}...\n${flow.title}`, { reply_markup: { inline_keyboard: [] } });
      this.enqueue({ type: 'single-audio', chatId, url: flow.url, title: flow.title, messageId, bitrate: value });
      return;
    }

    if (action === 'vq') {
      this.pendingFlows.delete(id);
      if (flow.kind === 'playlist') {
        await this.api.editMessage(
          chatId,
          messageId,
          [
            `Queued playlist as MP4.`,
            `Playlist: ${flow.title}`,
            `Items queued: ${flow.items.length}/${flow.total}`,
            `Quality: ${value}`,
            '',
            'I will try each item one by one and skip anything unavailable.',
          ].join('\n'),
          { reply_markup: { inline_keyboard: [] } },
        );
        this.enqueue({ type: 'playlist-video', chatId, messageId, title: flow.title, items: flow.items, total: flow.total, unavailable: flow.unavailable, quality: value });
        return;
      }

      await this.api.editMessage(chatId, messageId, `Queued MP4 ${value}...\n${flow.title}`, { reply_markup: { inline_keyboard: [] } });
      this.enqueue({ type: 'video', chatId, url: flow.url, quality: value, title: flow.title, messageId });
    }
  }

  async prepareVideoFormat(chatId, url) {
    const message = await this.api.sendMessage(chatId, `Detecting source...\n${url}`);
    try {
      const info = await analyzeVideo(this.tools, url, this.jobCancelToken);
      if (!info.hasAudio && !info.qualities.length) {
        await this.api.editMessage(chatId, message.message_id, 'No downloadable audio or video streams were found.');
        return;
      }
      const id = this.registerFlow({
        kind: 'single',
        chatId,
        url: info.webpageUrl || url,
        title: info.title,
        qualities: info.qualities,
      });
      await this.api.editMessage(
        chatId,
        message.message_id,
        [
          `Source detected: ${info.title}`,
          '',
          'Pick output format:',
        ].join('\n'),
        this.formatKeyboard(id),
      );
    } catch (error) {
      await this.api.editMessage(chatId, message.message_id, `Could not read this link:\n${error.message}`);
    }
  }

  async preparePlaylist(chatId, url) {
    const message = await this.api.sendMessage(chatId, `Reading playlist...\n${url}`);
    try {
      const flat = await getPlaylistFlat(this.tools, url, this.jobCancelToken);
      if (this.jobCancelToken.cancelled) throw new Error('Cancelled');
      const id = this.registerFlow({
        kind: 'playlist',
        chatId,
        url,
        title: flat.title,
        total: flat.total,
        items: flat.entries,
        unavailable: [],
      });
      await this.api.editMessage(
        chatId,
        message.message_id,
        [
          `Playlist: ${flat.title}`,
          `Total items: ${flat.total}`,
          '',
          'It will try each item in order after you choose format and quality.',
          'If one item is blocked or unavailable, it will be skipped and the queue will continue.',
          'Default is MP3 audio.',
        ].join('\n'),
        this.formatKeyboard(id),
      );
    } catch (error) {
      await this.api.editMessage(chatId, message.message_id, `Could not prepare playlist:\n${this.friendlyError(error)}`);
    }
  }

  enqueue(job) {
    this.queue.push(job);
    this.emit({ type: 'job', status: 'Queued', job });
    if (!this.processing) {
      this.processQueue();
    }
  }

  cancelJobs() {
    this.queue = [];
    requestCancel(this.jobCancelToken);
    this.pendingVideos.clear();
    this.pendingFlows.clear();
    this.emit({ type: 'job', status: 'Cancelled queued Telegram jobs', job: { type: 'cancel' } });
  }

  async processQueue() {
    this.processing = true;
    while (this.queue.length && !this.cancelToken.cancelled) {
      if (this.jobCancelToken.cancelled) {
        this.jobCancelToken = createCancelToken();
      }
      const job = this.queue.shift();
      try {
        if (job.type === 'playlist-audio') await this.processPlaylistAudio(job);
        if (job.type === 'playlist-video') await this.processPlaylistVideo(job);
        if (job.type === 'single-audio') await this.processSingleAudio(job);
        if (job.type === 'video') await this.processVideo(job);
      } catch (error) {
        if (/cancelled/i.test(error.message)) {
          await this.safeEdit(job.chatId, job.messageId, 'Cancelled.');
          this.emit({ type: 'job', status: 'Cancelled', job });
        } else {
          await this.safeEdit(job.chatId, job.messageId, `Failed:\n${this.friendlyError(error)}`);
          this.emit({ type: 'job', status: `Failed: ${error.message}`, job });
        }
      } finally {
        if (this.jobCancelToken.cancelled) {
          this.jobCancelToken = createCancelToken();
        }
      }
    }
    this.processing = false;
  }

  tempDir() {
    const dir = path.join(os.tmpdir(), `media_forge_bot_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    ensureDir(dir);
    return dir;
  }

  friendlyError(error) {
    const message = error && error.message ? error.message : String(error);
    if (/drm|protected/i.test(message)) return 'This link appears to be protected and cannot be downloaded.';
    if (/sign in to confirm|not a bot|cookies-from-browser|youtube.*bot/i.test(message)) {
      return 'YouTube asked for sign-in or bot verification, so this item was skipped.';
    }
    if (/private video|members-only|unavailable|copyright|removed/i.test(message)) {
      return 'This item is unavailable, private, removed, or restricted.';
    }
    if (/no mp3 output|no video output|no .*output was created/i.test(message)) {
      return 'The download finished without creating a usable file.';
    }
    return message.replace(/\s+/g, ' ').slice(0, 260);
  }

  unableText(title, error) {
    return `Unable to send "${cleanTitle(title)}".\n${this.friendlyError(error)}`;
  }

  async safeEdit(chatId, messageId, text) {
    try {
      await this.api.editMessage(chatId, messageId, text);
    } catch (_error) {
      // Progress edits are best effort.
    }
  }

  progressEditor(chatId, messageId, job) {
    let lastEdit = 0;
    let lastText = '';
    return async (text, force = false) => {
      const now = Date.now();
      if (!force && (now - lastEdit < 1500 || text === lastText)) return;
      lastEdit = now;
      lastText = text;
      this.emit({ type: 'job', status: text.split('\n')[0], job });
      await this.safeEdit(chatId, messageId, text);
    };
  }

  async processSingleAudio(job) {
    const dir = this.tempDir();
    const edit = this.progressEditor(job.chatId, job.messageId, job);
    try {
      await edit(`Starting MP3...\n${job.url}`, true);
      const result = await downloadAudio(this.tools, {
        url: job.url,
        outputDir: dir,
        bitrate: job.bitrate || this.bitrate,
        noPlaylist: true,
        cancelToken: this.jobCancelToken,
        onProgress: (progress) => edit(`${progress.stage}${progress.percent == null ? '' : ` ${progress.percent.toFixed(1)}%`}\n${job.url}`),
      });
      await this.sendAndDeleteAudio(job, result.filePath, edit);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async processPlaylistAudio(job) {
    const items = job.items || [];
    await this.safeEdit(
      job.chatId,
      job.messageId,
      [
        `Playlist queued as MP3.`,
        `Playlist: ${job.title || 'Playlist'}`,
        `Items queued: ${items.length}/${job.total || items.length}`,
        `Quality: ${job.bitrate || this.bitrate}`,
        '',
        'Starting one by one...',
      ].join('\n'),
    );

    let sent = 0;
    let skipped = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (this.cancelToken.cancelled || this.jobCancelToken.cancelled) break;
      const item = items[index];
      const progress = await this.api.sendMessage(job.chatId, `Playlist ${index + 1}/${items.length}\n${item.title}`);
      try {
        await this.processSingleAudio({
          ...job,
          type: 'single-audio',
          url: item.url,
          messageId: progress.message_id,
          bitrate: job.bitrate || this.bitrate,
        });
        sent += 1;
      } catch (error) {
        if (/cancelled/i.test(error.message)) throw error;
        skipped += 1;
        await this.safeEdit(job.chatId, progress.message_id, this.unableText(item.title, error));
        this.emit({ type: 'job', status: `Skipped: ${this.friendlyError(error)}`, job: { ...job, title: item.title, url: item.url } });
      }
      await this.safeEdit(
        job.chatId,
        job.messageId,
        [
          `Playlist running as MP3.`,
          `Playlist: ${job.title || 'Playlist'}`,
          `Progress: ${index + 1}/${items.length}`,
          `Sent: ${sent}`,
          `Skipped: ${skipped}`,
        ].join('\n'),
      );
    }
    await this.safeEdit(job.chatId, job.messageId, `Playlist finished.\nSent: ${sent}\nSkipped: ${skipped}`);
  }

  async processPlaylistVideo(job) {
    const items = job.items || [];
    await this.safeEdit(
      job.chatId,
      job.messageId,
      [
        `Playlist queued as MP4.`,
        `Playlist: ${job.title || 'Playlist'}`,
        `Items queued: ${items.length}/${job.total || items.length}`,
        `Quality: ${job.quality || 'best'}`,
        '',
        'Starting one by one...',
      ].join('\n'),
    );

    let sent = 0;
    let skipped = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (this.cancelToken.cancelled || this.jobCancelToken.cancelled) break;
      const item = items[index];
      const progress = await this.api.sendMessage(job.chatId, `Playlist video ${index + 1}/${items.length}\n${item.title}`);
      try {
        await this.processVideo({
          ...job,
          type: 'video',
          url: item.url,
          title: item.title,
          messageId: progress.message_id,
          quality: job.quality || 'best',
        });
        sent += 1;
      } catch (error) {
        if (/cancelled/i.test(error.message)) throw error;
        skipped += 1;
        await this.safeEdit(job.chatId, progress.message_id, this.unableText(item.title, error));
        this.emit({ type: 'job', status: `Skipped: ${this.friendlyError(error)}`, job: { ...job, title: item.title, url: item.url } });
      }
      await this.safeEdit(
        job.chatId,
        job.messageId,
        [
          `Playlist running as MP4.`,
          `Playlist: ${job.title || 'Playlist'}`,
          `Progress: ${index + 1}/${items.length}`,
          `Sent: ${sent}`,
          `Skipped: ${skipped}`,
        ].join('\n'),
      );
    }
    await this.safeEdit(job.chatId, job.messageId, `Playlist finished.\nSent: ${sent}\nSkipped: ${skipped}`);
  }

  async processVideo(job) {
    const dir = this.tempDir();
    const edit = this.progressEditor(job.chatId, job.messageId, job);
    try {
      await edit(`Starting video ${job.quality}...\n${job.title || job.url}`, true);
      const result = await downloadVideo(this.tools, {
        url: job.url,
        outputDir: dir,
        quality: job.quality,
        cancelToken: this.jobCancelToken,
        onProgress: (progress) => edit(`${progress.stage}${progress.percent == null ? '' : ` ${progress.percent.toFixed(1)}%`}\n${job.quality}\n${job.title || job.url}`),
      });
      await this.sendAndDeleteVideo(job, result.filePath, edit);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  checkSize(filePath) {
    const size = fs.statSync(filePath).size;
    const max = this.maxFileMb * 1024 * 1024;
    if (size > max) {
      throw new Error(`File is ${humanBytes(size)}, over the ${this.maxFileMb} MB app limit.`);
    }
    return size;
  }

  async sendAndDeleteAudio(job, filePath, edit) {
    const title = cleanTitle(path.basename(filePath, path.extname(filePath)));
    const size = this.checkSize(filePath);
    await edit(`Sending MP3...\n${title}\n${humanBytes(size)}`, true);
    await this.api.sendAudio(job.chatId, filePath, {
      title,
      caption: `${title}\nSource: ${job.url}`,
    }, (sent, total) => edit(`Sending MP3 ${total ? ((sent / total) * 100).toFixed(1) : '0'}%\n${title}`), this.jobCancelToken);
    fs.rmSync(filePath, { force: true });
    await edit('Sent successfully. Local file deleted.', true);
  }

  async sendAndDeleteVideo(job, filePath, edit) {
    const title = cleanTitle(job.title || path.basename(filePath, path.extname(filePath)));
    const size = this.checkSize(filePath);
    await edit(`Sending video...\n${title}\n${job.quality}\n${humanBytes(size)}`, true);
    await this.api.sendVideo(job.chatId, filePath, {
      caption: `${title}\nQuality: ${job.quality}\nSource: ${job.url}`,
      supports_streaming: true,
    }, (sent, total) => edit(`Sending video ${total ? ((sent / total) * 100).toFixed(1) : '0'}%\n${title}`), this.jobCancelToken);
    fs.rmSync(filePath, { force: true });
    await edit('Video sent successfully. Local file deleted.', true);
  }
}

module.exports = {
  TelegramBotController,
  helpText,
  extractUrls,
};
