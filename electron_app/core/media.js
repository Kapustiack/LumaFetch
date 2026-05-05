const fs = require('node:fs');
const path = require('node:path');

const MEDIA_EXTENSIONS = new Set([
  '.webm',
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.m4a',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
  '.mp3',
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov']);

function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(name) {
  return String(name || 'media')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'media';
}

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  let index = 2;
  while (true) {
    const candidate = path.join(dir, `${stem} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function newestFile(dirPath, extensions, startMs) {
  const found = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(full).toLowerCase();
        const stat = fs.statSync(full);
        if (extensions.has(ext) && stat.mtimeMs >= startMs - 1000) {
          found.push({ filePath: full, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  walk(dirPath);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] ? found[0].filePath : null;
}

module.exports = {
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isMediaFile,
  ensureDir,
  sanitizeFileName,
  uniquePath,
  newestFile,
};
