const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_RELEASE_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';

function appRoot() {
  return path.resolve(__dirname, '..', '..');
}

function dependenciesDir(userDataPath) {
  return path.join(userDataPath, 'dependencies');
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: options.cwd,
      env: options.env || process.env,
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs || 30000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
      }
    });
  });
}

function exists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function candidateToolDirs(userDataPath) {
  const dirs = [];
  if (userDataPath) {
    dirs.push(dependenciesDir(userDataPath));
    dirs.push(path.join(userDataPath, 'tools'));
  }
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'dependencies'));
    dirs.push(path.join(process.resourcesPath, 'tools'));
  }
  const root = appRoot();
  if (!root.toLowerCase().includes('.asar')) {
    dirs.push(path.join(root, 'electron_app', 'vendor'));
  }
  return [...new Set(dirs)];
}

async function findPython() {
  const candidates = [
    { command: 'python', prefix: [] },
    { command: 'py', prefix: ['-3'] },
  ];
  for (const candidate of candidates) {
    try {
      await runCapture(candidate.command, [...candidate.prefix, '--version'], { timeoutMs: 10000 });
      return candidate;
    } catch (_error) {
      // Try the next candidate.
    }
  }
  return null;
}

async function systemWhich(name) {
  try {
    const found = await runCapture('where.exe', [name], { timeoutMs: 10000 });
    return found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch (_error) {
    return null;
  }
}

async function findYtdlp(userDataPath) {
  for (const dir of candidateToolDirs(userDataPath)) {
    const candidate = path.join(dir, 'yt-dlp.exe');
    if (exists(candidate)) return { mode: 'exe', command: candidate, prefix: [], version: null, source: candidate };
  }

  const system = await systemWhich('yt-dlp.exe');
  if (system) return { mode: 'exe', command: system, prefix: [], version: null, source: system };

  const python = await findPython();
  if (python) {
    try {
      const version = await runCapture(python.command, [...python.prefix, '-m', 'yt_dlp', '--version'], { timeoutMs: 20000 });
      return {
        mode: 'python',
        command: python.command,
        prefix: [...python.prefix, '-m', 'yt_dlp'],
        version: version.stdout.trim(),
        source: 'python module',
        python,
      };
    } catch (_error) {
      // Missing module.
    }
  }
  return null;
}

async function findFfmpeg(userDataPath) {
  for (const dir of candidateToolDirs(userDataPath)) {
    const candidate = path.join(dir, 'ffmpeg.exe');
    if (exists(candidate)) return candidate;
  }

  const system = await systemWhich('ffmpeg.exe');
  if (system) return system;

  const python = await findPython();
  if (python) {
    try {
      const result = await runCapture(
        python.command,
        [...python.prefix, '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
        { timeoutMs: 20000 },
      );
      const ffmpegPath = result.stdout.trim();
      if (exists(ffmpegPath)) return ffmpegPath;
    } catch (_error) {
      // Missing module.
    }
  }
  return null;
}

async function checkDependencies(userDataPath) {
  const [python, ytdlp, ffmpegPath] = await Promise.all([
    findPython(),
    findYtdlp(userDataPath),
    findFfmpeg(userDataPath),
  ]);
  const missing = [];
  if (!ytdlp) missing.push('yt-dlp');
  if (!ffmpegPath) missing.push('ffmpeg');
  return {
    ok: missing.length === 0,
    missing,
    python: python ? python.command : null,
    ytdlp: ytdlp ? { mode: ytdlp.mode, source: ytdlp.source, version: ytdlp.version } : null,
    ffmpegPath,
  };
}

async function findTools(userDataPath) {
  const ytdlp = await findYtdlp(userDataPath);
  const ffmpegPath = await findFfmpeg(userDataPath);
  if (!ytdlp || !ffmpegPath) {
    const missing = [!ytdlp && 'yt-dlp', !ffmpegPath && 'ffmpeg'].filter(Boolean).join(', ');
    throw new Error(`Missing required tools: ${missing}`);
  }
  return {
    ytdlpCommand: ytdlp.command,
    ytdlpPrefix: ytdlp.prefix,
    ytdlpMode: ytdlp.mode,
    ytdlpVersion: ytdlp.version,
    ffmpegPath,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseJsonResponse(text, url) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse response from ${url}: ${error.message}`);
  }
}

function requestText(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const request = https.get(requestUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'LumaFetch',
      },
      timeout: timeoutMs,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) {
          reject(new Error('Request redirect did not include a location.'));
          return;
        }
        requestText(new URL(response.headers.location, requestUrl).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      let text = '';
      response.on('data', (chunk) => { text += chunk.toString(); });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Request failed: HTTP ${response.statusCode}`));
          return;
        }
        resolve(text);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
  });
}

function selectFfmpegAsset(assets = []) {
  return assets.find((asset) => /^ffmpeg-N-.*-win64-gpl\.zip$/i.test(asset.name))
    || assets.find((asset) => /^ffmpeg-.*-win64-gpl(?:-[\d.]+)?\.zip$/i.test(asset.name) && !/-shared/i.test(asset.name));
}

async function resolveFfmpegZipUrl() {
  const release = parseJsonResponse(await requestText(FFMPEG_RELEASE_API), FFMPEG_RELEASE_API);
  const asset = selectFfmpegAsset(release.assets || []);
  if (!asset || !asset.browser_download_url) {
    throw new Error('Could not find a Windows ffmpeg archive in the latest release.');
  }
  return asset.browser_download_url;
}

function downloadFile(url, destination, onProgress) {
  ensureDir(path.dirname(destination));
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const request = https.get(requestUrl, { headers: { 'User-Agent': 'LumaFetch' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) {
          reject(new Error('Download redirect did not include a location.'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, requestUrl).toString();
        downloadFile(redirectUrl, destination, onProgress).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers['content-length'] || 0);
      let downloaded = 0;
      const file = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) onProgress(downloaded / total);
      });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function copyImageioFfmpeg(targetPath, onStep) {
  const python = await findPython();
  if (!python) return false;
  try {
    const result = await runCapture(
      python.command,
      [...python.prefix, '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { timeoutMs: 20000 },
    );
    const source = result.stdout.trim();
    if (exists(source)) {
      onStep('Copying local ffmpeg', 58);
      fs.copyFileSync(source, targetPath);
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function findFileRecursive(dirPath, fileName) {
  if (!fs.existsSync(dirPath)) return null;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, fileName);
      if (found) return found;
    }
  }
  return null;
}

async function installFfmpegFromZip(targetPath, onStep) {
  const tempRoot = fs.mkdtempSync(path.join(path.dirname(targetPath), 'ffmpeg-download-'));
  const zipPath = path.join(tempRoot, 'ffmpeg.zip');
  const extractPath = path.join(tempRoot, 'extract');
  try {
    onStep('Resolving ffmpeg download', 56);
    const ffmpegUrl = await resolveFfmpegZipUrl();
    onStep('Downloading ffmpeg', 60);
    await downloadFile(ffmpegUrl, zipPath, (ratio) => onStep('Downloading ffmpeg', 60 + Math.floor(ratio * 20)));
    onStep('Extracting ffmpeg', 82);
    ensureDir(extractPath);
    await runCapture('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${extractPath}" -Force`], { timeoutMs: 240000 });
    const source = findFileRecursive(extractPath, 'ffmpeg.exe');
    if (!source) throw new Error('Could not find ffmpeg.exe in downloaded archive.');
    fs.copyFileSync(source, targetPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function installDependencies(userDataPath, onStep = () => {}) {
  const installDir = dependenciesDir(userDataPath);
  ensureDir(installDir);
  onStep('Checking tools', 2);
  const before = await checkDependencies(userDataPath);

  if (!before.ytdlp) {
    const target = path.join(installDir, 'yt-dlp.exe');
    onStep('Downloading yt-dlp', 8);
    await downloadFile(YTDLP_URL, target, (ratio) => onStep('Downloading yt-dlp', 8 + Math.floor(ratio * 32)));
  } else {
    onStep('yt-dlp ready', 40);
  }

  const afterYtdlp = await checkDependencies(userDataPath);
  if (!afterYtdlp.ffmpegPath) {
    const target = path.join(installDir, 'ffmpeg.exe');
    onStep('Preparing ffmpeg', 52);
    const copied = await copyImageioFfmpeg(target, onStep);
    if (!copied) {
      await installFfmpegFromZip(target, onStep);
    }
  } else {
    onStep('ffmpeg ready', 84);
  }

  onStep('Verifying install', 92);
  const finalStatus = await checkDependencies(userDataPath);
  if (!finalStatus.ok) {
    throw new Error(`Still missing: ${finalStatus.missing.join(', ')}`);
  }
  onStep('Ready', 100);
  return finalStatus;
}

module.exports = {
  runCapture,
  findTools,
  checkDependencies,
  installDependencies,
  dependenciesDir,
  resolveFfmpegZipUrl,
  selectFfmpegAsset,
};
