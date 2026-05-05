const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { registerCancelableChild, killProcessTree } = require('./cancel');
const { isMediaFile, ensureDir, uniquePath } = require('./media');

const DURATION_RE = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;

function collectMediaFiles(paths, recursive = true) {
  const files = [];
  const seen = new Set();

  function addFile(filePath) {
    const resolved = path.resolve(filePath);
    const key = resolved.toLowerCase();
    if (!seen.has(key) && isMediaFile(resolved)) {
      seen.add(key);
      files.push(resolved);
    }
  }

  function walk(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory() && recursive) {
        walk(full);
      } else if (entry.isFile()) {
        addFile(full);
      }
    }
  }

  for (const inputPath of paths || []) {
    if (!inputPath || !fs.existsSync(inputPath)) continue;
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) walk(inputPath);
    if (stat.isFile()) addFile(inputPath);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function parseDuration(text) {
  const match = DURATION_RE.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function probeDuration(ffmpegPath, filePath, cancelToken) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    registerCancelableChild(cancelToken, child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('close', () => resolve(parseDuration(output)));
    child.on('error', () => resolve(null));
    const timer = setInterval(() => {
      if (cancelToken && cancelToken.cancelled) {
        killProcessTree(child);
      }
    }, 250);
    child.on('close', () => clearInterval(timer));
    child.on('error', () => clearInterval(timer));
  });
}

function parseProgressLine(line) {
  const [key, value] = line.trim().split('=');
  if (key === 'out_time_ms' || key === 'out_time_us') {
    const raw = Number(value);
    return Number.isFinite(raw) ? raw / 1000000 : null;
  }
  return null;
}

function convertOne({ ffmpegPath, inputPath, outputPath, bitrate, duration, cancelToken, onProgress }) {
  ensureDir(path.dirname(outputPath));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      bitrate,
      '-progress',
      'pipe:1',
      '-nostats',
      outputPath,
    ], { windowsHide: true });
    registerCancelableChild(cancelToken, child);

    let tail = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      tail += text;
      for (const line of text.split(/\r?\n/)) {
        const seconds = parseProgressLine(line);
        if (seconds !== null && duration) {
          onProgress(Math.max(0, Math.min(100, (seconds / duration) * 100)));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      tail = `${tail}${chunk.toString()}`.slice(-4000);
    });
    const timer = setInterval(() => {
      if (cancelToken.cancelled) {
        killProcessTree(child);
      }
    }, 250);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (cancelToken.cancelled) {
        fs.rmSync(outputPath, { force: true });
        reject(new Error('Cancelled'));
      } else if (code === 0) {
        onProgress(100);
        resolve(outputPath);
      } else {
        reject(new Error(tail.trim().split(/\r?\n/).slice(-2).join(' ') || `ffmpeg exited ${code}`));
      }
    });
  });
}

async function convertBatch({ ffmpegPath, files, outputDir, bitrate, cancelToken, onEvent }) {
  ensureDir(outputDir);
  const mediaFiles = collectMediaFiles(files, true);
  const results = [];

  for (let index = 0; index < mediaFiles.length; index += 1) {
    if (cancelToken.cancelled) break;
    const inputPath = mediaFiles[index];
    const outputPath = uniquePath(path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.mp3`));
    onEvent({ type: 'item', index: index + 1, total: mediaFiles.length, inputPath, outputPath, status: 'Reading' });
    const duration = await probeDuration(ffmpegPath, inputPath, cancelToken);
    if (cancelToken.cancelled) {
      onEvent({ type: 'cancelled' });
      break;
    }
    onEvent({ type: 'item', index: index + 1, total: mediaFiles.length, inputPath, outputPath, status: 'Converting' });
    try {
      await convertOne({
        ffmpegPath,
        inputPath,
        outputPath,
        bitrate,
        duration,
        cancelToken,
        onProgress: (percent) => {
          const overall = ((index + percent / 100) / mediaFiles.length) * 100;
          onEvent({ type: 'progress', current: percent, overall });
        },
      });
      results.push(outputPath);
      onEvent({ type: 'done', inputPath, outputPath });
    } catch (error) {
      if (cancelToken.cancelled) {
        onEvent({ type: 'cancelled' });
        break;
      }
      onEvent({ type: 'failed', inputPath, outputPath, error: error.message });
    }
  }

  onEvent({ type: cancelToken.cancelled ? 'cancelled' : 'complete', files: results });
  return { ok: !cancelToken.cancelled, files: results };
}

module.exports = {
  collectMediaFiles,
  convertBatch,
};
