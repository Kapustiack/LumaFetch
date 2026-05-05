const { spawn } = require('node:child_process');
const path = require('node:path');

const { registerCancelableChild, killProcessTree } = require('./cancel');
const { ensureDir, newestFile } = require('./media');

const OUTPUT_EXTENSIONS = new Set(['.mp3', '.m4a', '.opus', '.webm', '.mp4', '.mkv', '.mov']);
const VIDEO_OUTPUT_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov']);

function pythonArgs(tools, args) {
  return [...(tools.ytdlpPrefix || []), ...args];
}

function cookiesArgs(cookiesBrowser) {
  const browser = String(cookiesBrowser || '').trim();
  return browser ? ['--cookies-from-browser', browser] : [];
}

function runYtdlpJson(tools, args, timeoutMs = 120000, cancelToken = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ytdlpCommand, pythonArgs(tools, args), { windowsHide: true });
    registerCancelableChild(cancelToken, child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelToken && cancelToken.cancelled) {
        reject(new Error('Cancelled'));
        return;
      }
      if (timedOut) {
        reject(new Error('yt-dlp timed out'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse yt-dlp output: ${error.message}`));
      }
    });
  });
}

function parsePercent(line) {
  const match = /\[download\]\s+([0-9.]+)%/.exec(line);
  return match ? Number(match[1]) : null;
}

function runYtdlpDownload(tools, args, { cancelToken, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ytdlpCommand, pythonArgs(tools, args), {
      windowsHide: true,
    });
    registerCancelableChild(cancelToken, child);
    let tail = '';
    const handleText = (text) => {
      tail = `${tail}${text}`.slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        const percent = parsePercent(line);
        if (percent !== null) {
          onProgress({ stage: 'Downloading', percent, detail: line.trim() });
        } else if (line.includes('ExtractAudio') || line.includes('Destination')) {
          onProgress({ stage: 'Converting', percent: null, detail: line.trim() });
        }
      }
    };
    child.stdout.on('data', (chunk) => handleText(chunk.toString()));
    child.stderr.on('data', (chunk) => handleText(chunk.toString()));
    const timer = setInterval(() => {
      if (cancelToken && cancelToken.cancelled) {
        killProcessTree(child);
      }
    }, 300);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (cancelToken && cancelToken.cancelled) {
        reject(new Error('Cancelled'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(tail.trim().split(/\r?\n/).slice(-3).join(' ') || `yt-dlp exited ${code}`));
      }
    });
  });
}

function normalizeEntryUrl(entry) {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return entry.url;
}

function makeQualityList(info) {
  const heights = new Set();
  let hasVideo = false;
  for (const format of info.formats || []) {
    if (format.vcodec && format.vcodec !== 'none' && Number(format.height)) {
      heights.add(Number(format.height));
    }
    if (format.vcodec && format.vcodec !== 'none') {
      hasVideo = true;
    }
  }
  const qualities = [...heights]
    .sort((a, b) => b - a)
    .map((height) => ({
      label: `${height}p`,
      height,
    }));
  if (!qualities.length && hasVideo) {
    qualities.push({ label: 'best', height: null });
  }
  return qualities;
}

async function analyzeVideo(tools, url, cancelToken = null, options = {}) {
  const info = await runYtdlpJson(tools, [
    '--dump-single-json',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    ...cookiesArgs(options.cookiesBrowser),
    url,
  ], 120000, cancelToken);
  return {
    id: info.id,
    title: info.title || 'video',
    webpageUrl: info.webpage_url || url,
    duration: info.duration || null,
    qualities: makeQualityList(info),
    hasAudio: (info.formats || []).some((format) => format.acodec && format.acodec !== 'none'),
  };
}

async function getPlaylistFlat(tools, url, cancelToken = null, options = {}) {
  const info = await runYtdlpJson(tools, [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    ...cookiesArgs(options.cookiesBrowser),
    url,
  ], 180000, cancelToken);
  const entries = (info.entries || [])
    .map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id || 'Untitled',
      url: normalizeEntryUrl(entry),
    }))
    .filter((entry) => entry.url);
  return {
    title: info.title || 'Playlist',
    total: entries.length,
    entries,
  };
}

async function checkPlaylistItems(tools, entries, {
  cancelToken,
  onProgress,
  mediaType = 'audio',
  cookiesBrowser = '',
}) {
  const available = [];
  const unavailable = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (cancelToken && cancelToken.cancelled) break;
    const entry = entries[index];
    onProgress({ index: index + 1, total: entries.length, title: entry.title });
    try {
      const info = await analyzeVideo(tools, entry.url, cancelToken, { cookiesBrowser });
      const canUse = mediaType === 'video' ? info.qualities.length > 0 : info.hasAudio;
      if (canUse) {
        available.push({
          ...entry,
          title: info.title || entry.title,
          url: info.webpageUrl || entry.url,
          qualities: info.qualities,
        });
      } else {
        unavailable.push({ ...entry, reason: mediaType === 'video' ? 'No video stream found' : 'No audio stream found' });
      }
    } catch (error) {
      unavailable.push({ ...entry, reason: error.message });
    }
  }
  return { available, unavailable };
}

async function downloadAudio(tools, options) {
  const {
    url,
    outputDir,
    bitrate,
    noPlaylist,
    cancelToken,
    onProgress,
  } = options;
  ensureDir(outputDir);
  const startMs = Date.now();
  await runYtdlpDownload(tools, [
    '--newline',
    '--no-colors',
    '--no-warnings',
    '--windows-filenames',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--concurrent-fragments',
    '5',
    ...cookiesArgs(options.cookiesBrowser),
    '--ffmpeg-location',
    tools.ffmpegPath,
    '-f',
    'bestaudio/best',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    String(bitrate || '192k').replace(/k$/i, ''),
    ...(noPlaylist ? ['--no-playlist'] : []),
    '-o',
    path.join(outputDir, '%(title).180B [%(id)s].%(ext)s'),
    url,
  ], { cancelToken, onProgress });
  const filePath = newestFile(outputDir, new Set(['.mp3']), startMs);
  if (!filePath) throw new Error('No MP3 output was created.');
  return { filePath };
}

function qualityHeight(quality) {
  if (!quality || quality === 'best') return null;
  const match = /(\d+)/.exec(String(quality));
  return match ? Number(match[1]) : null;
}

function formatSelectorForQuality(quality) {
  const height = qualityHeight(quality);
  if (!height) return 'bv*+ba/b';
  return `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]`;
}

async function downloadVideo(tools, options) {
  const {
    url,
    outputDir,
    quality,
    cancelToken,
    onProgress,
  } = options;
  ensureDir(outputDir);
  const startMs = Date.now();
  await runYtdlpDownload(tools, [
    '--newline',
    '--no-colors',
    '--no-warnings',
    '--windows-filenames',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--concurrent-fragments',
    '5',
    ...cookiesArgs(options.cookiesBrowser),
    '--ffmpeg-location',
    tools.ffmpegPath,
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '-f',
    formatSelectorForQuality(quality),
    '-o',
    path.join(outputDir, '%(title).180B [%(id)s].%(ext)s'),
    url,
  ], { cancelToken, onProgress });
  const filePath = newestFile(outputDir, VIDEO_OUTPUT_EXTENSIONS, startMs) || newestFile(outputDir, OUTPUT_EXTENSIONS, startMs);
  if (!filePath) throw new Error('No video output was created.');
  return { filePath };
}

module.exports = {
  analyzeVideo,
  getPlaylistFlat,
  checkPlaylistItems,
  downloadAudio,
  downloadVideo,
  formatSelectorForQuality,
};
