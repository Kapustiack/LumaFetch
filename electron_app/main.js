const { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
} catch (_error) {
  autoUpdater = null;
}

const { createCancelToken, requestCancel } = require('./core/cancel');
const { findTools, checkDependencies, installDependencies } = require('./core/tools');
const { collectMediaFiles, convertBatch } = require('./core/converter');
const {
  analyzeVideo,
  downloadAudio,
  downloadVideo,
  getPlaylistFlat,
} = require('./core/ytdlp');
const { TelegramBotController } = require('./core/telegramBot');

let mainWindow;
let toolsPromise;
let localCancel = createCancelToken();
let youtubeCancel = createCancelToken();
let botController = null;

app.setName('LumaFetch');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultOutputDir: '',
  defaultAudioQuality: '192k',
  defaultVideoQuality: 'best',
  telegramMaxMb: 50,
  telegramLockChat: true,
  youtubeCookiesBrowser: '',
  autoUpdate: true,
  lastTempCleanupAt: null,
};

const THEMES = new Set(['dark', 'light', 'system']);
const AUDIO_QUALITIES = new Set(['128k', '192k', '256k', '320k']);
const VIDEO_QUALITIES = new Set(['best', '1080p', '720p', '480p', '360p']);
const COOKIE_BROWSERS = new Set(['', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium']);

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    frame: true,
    transparent: false,
    hasShadow: true,
    backgroundColor: '#080a0f',
    autoHideMenuBar: true,
    title: 'LumaFetch',
    icon: path.join(__dirname, 'assets', 'lumafetch-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getTools() {
  if (!toolsPromise) {
    toolsPromise = findTools(app.getPath('userData'));
  }
  return toolsPromise;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_error) {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function normalizePublicSettings(settings) {
  const source = settings || {};
  const publicSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      publicSettings[key] = source[key];
    }
  }

  if (!THEMES.has(publicSettings.theme)) publicSettings.theme = DEFAULT_SETTINGS.theme;
  if (!AUDIO_QUALITIES.has(publicSettings.defaultAudioQuality)) publicSettings.defaultAudioQuality = DEFAULT_SETTINGS.defaultAudioQuality;
  if (!VIDEO_QUALITIES.has(publicSettings.defaultVideoQuality)) publicSettings.defaultVideoQuality = DEFAULT_SETTINGS.defaultVideoQuality;
  if (!COOKIE_BROWSERS.has(publicSettings.youtubeCookiesBrowser)) publicSettings.youtubeCookiesBrowser = '';
  publicSettings.defaultOutputDir = String(publicSettings.defaultOutputDir || '');
  publicSettings.telegramMaxMb = clampNumber(publicSettings.telegramMaxMb, DEFAULT_SETTINGS.telegramMaxMb, 1, 2000);
  publicSettings.telegramLockChat = publicSettings.telegramLockChat !== false;
  publicSettings.autoUpdate = publicSettings.autoUpdate !== false;
  publicSettings.lastTempCleanupAt = publicSettings.lastTempCleanupAt || null;

  return publicSettings;
}

function publicSettings() {
  const settings = readSettings();
  const normalized = normalizePublicSettings(settings);
  delete normalized.botToken;
  return normalized;
}

function updatePublicSettings(patch = {}) {
  const current = readSettings();
  const merged = normalizePublicSettings({
    ...current,
    ...patch,
  });
  if (current.botToken) merged.botToken = current.botToken;
  writeSettings(merged);
  const response = { ...merged };
  delete response.botToken;
  return response;
}

function rememberTempCleanup() {
  const settings = readSettings();
  writeSettings({
    ...settings,
    lastTempCleanupAt: new Date().toISOString(),
  });
}

function cleanTempFiles() {
  const tempRoot = os.tmpdir();
  const prefixes = ['lumafetch_bot_', 'lumafetch_', 'lumafetch-'];
  let removed = 0;
  let freedBytes = 0;

  function entrySize(targetPath) {
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isFile()) return stat.size;
      if (!stat.isDirectory()) return 0;
      return fs.readdirSync(targetPath).reduce((total, name) => total + entrySize(path.join(targetPath, name)), 0);
    } catch (_error) {
      return 0;
    }
  }

  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const target = path.join(tempRoot, entry.name);
    try {
      freedBytes += entrySize(target);
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (_error) {
      // Skip temp folders still in use by another process.
    }
  }

  rememberTempCleanup();
  return { removed, freedBytes, cleanedAt: new Date().toISOString() };
}

async function diagnostics() {
  const dependencyStatus = await checkDependencies(app.getPath('userData'));
  return {
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    tempDir: os.tmpdir(),
    resourcesPath: process.resourcesPath,
    dependencyStatus,
    settings: publicSettings(),
    updates: {
      available: Boolean(autoUpdater),
      configured: Boolean(autoUpdater && app.isPackaged),
    },
  };
}

function readSavedBotToken() {
  const settings = readSettings();
  const stored = settings.botToken;
  if (!stored) return '';
  try {
    if (stored.encrypted && stored.value && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
    }
    return stored.value || '';
  } catch (_error) {
    return '';
  }
}

function saveBotToken(token) {
  const settings = readSettings();
  const value = String(token || '').trim();
  if (!value) {
    delete settings.botToken;
    writeSettings(settings);
    return { saved: false };
  }

  if (safeStorage.isEncryptionAvailable()) {
    settings.botToken = {
      encrypted: true,
      value: safeStorage.encryptString(value).toString('base64'),
    };
  } else {
    settings.botToken = {
      encrypted: false,
      value,
    };
  }
  writeSettings(settings);
  return { saved: true };
}

function wireAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.on('checking-for-update', () => send('updates:event', { type: 'checking', message: 'Checking for updates...' }));
  autoUpdater.on('update-available', (info) => send('updates:event', { type: 'available', message: `Update ${info.version} is available.`, info }));
  autoUpdater.on('update-not-available', (info) => send('updates:event', { type: 'none', message: 'LumaFetch is up to date.', info }));
  autoUpdater.on('error', (error) => send('updates:event', { type: 'error', message: error.message }));
}

app.whenReady().then(() => {
  wireAutoUpdater();
  try {
    cleanTempFiles();
  } catch (_error) {
    // Temp cleanup is opportunistic and should never block startup.
  }
  createWindow();
  if (autoUpdater && app.isPackaged && publicSettings().autoUpdate) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  }
});

app.on('window-all-closed', () => {
  if (botController) {
    botController.stop();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('dialog:files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose media files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['webm', 'mp4', 'mkv', 'mov', 'avi', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'mp3'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:outputFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_event, filePath) => {
  if (filePath) {
    await shell.openPath(filePath);
  }
});

ipcMain.handle('dependencies:check', async () => {
  return checkDependencies(app.getPath('userData'));
});

ipcMain.handle('dependencies:install', async () => {
  const status = await installDependencies(app.getPath('userData'), (message, percent) => {
    send('dependencies:event', { message, percent });
  });
  toolsPromise = null;
  return status;
});

ipcMain.handle('settings:get', async () => publicSettings());

ipcMain.handle('settings:save', async (_event, patch) => updatePublicSettings(patch));

ipcMain.handle('settings:diagnostics', async () => diagnostics());

ipcMain.handle('settings:cleanTemp', async () => cleanTempFiles());

ipcMain.handle('updates:check', async () => {
  if (!autoUpdater) {
    return { ok: false, message: 'Updater module is not available.' };
  }
  if (!app.isPackaged) {
    return { ok: false, message: 'Updates can be checked from an installed build.' };
  }
  const result = await autoUpdater.checkForUpdates();
  return { ok: true, updateInfo: result && result.updateInfo ? result.updateInfo : null };
});

ipcMain.handle('bot:getSavedToken', async () => {
  return { token: readSavedBotToken() };
});

ipcMain.handle('bot:saveToken', async (_event, { token }) => {
  return saveBotToken(token);
});

ipcMain.handle('local:scanFolder', async (_event, { folder, recursive }) => {
  return collectMediaFiles([folder], Boolean(recursive));
});

ipcMain.handle('local:collectPaths', async (_event, { paths: inputPaths, recursive }) => {
  return collectMediaFiles(inputPaths, Boolean(recursive));
});

ipcMain.handle('local:convert', async (_event, { files, outputDir, bitrate }) => {
  const tools = await getTools();
  localCancel = createCancelToken();
  return convertBatch({
    ffmpegPath: tools.ffmpegPath,
    files,
    outputDir,
    bitrate,
    cancelToken: localCancel,
    onEvent: (payload) => send('local:event', payload),
  });
});

ipcMain.handle('local:cancel', async () => {
  requestCancel(localCancel);
  send('local:event', { type: 'cancelled' });
  return true;
});

ipcMain.handle('youtube:analyze', async (_event, { url }) => {
  const tools = await getTools();
  const settings = publicSettings();
  youtubeCancel = createCancelToken();
  return analyzeVideo(tools, url, youtubeCancel, { cookiesBrowser: settings.youtubeCookiesBrowser });
});

ipcMain.handle('youtube:downloadAudio', async (_event, { url, outputDir, bitrate, playlist }) => {
  const tools = await getTools();
  const settings = publicSettings();
  youtubeCancel = createCancelToken();
  if (playlist) {
    const flat = await getPlaylistFlat(tools, url, youtubeCancel, { cookiesBrowser: settings.youtubeCookiesBrowser });
    if (youtubeCancel.cancelled) throw new Error('Cancelled');
    send('youtube:event', {
      type: 'playlist-ready',
      total: flat.total,
      available: flat.entries.length,
      unavailable: 0,
    });
    const results = [];
    for (let index = 0; index < flat.entries.length; index += 1) {
      if (youtubeCancel.cancelled) break;
      const item = flat.entries[index];
      send('youtube:event', {
        type: 'playlist-item',
        index: index + 1,
        total: flat.entries.length,
        title: item.title,
      });
      try {
        const result = await downloadAudio(tools, {
          url: item.url,
          outputDir,
          bitrate,
          noPlaylist: true,
          cancelToken: youtubeCancel,
          cookiesBrowser: settings.youtubeCookiesBrowser,
          onProgress: (payload) => send('youtube:event', { type: 'download', ...payload }),
        });
        results.push(result);
      } catch (error) {
        if (/cancelled/i.test(error.message)) throw error;
        send('youtube:event', { type: 'download', stage: `Skipped: ${error.message}`, percent: null });
      }
    }
    if (youtubeCancel.cancelled) throw new Error('Cancelled');
    return { ok: true, files: results.map((item) => item.filePath) };
  }

  const result = await downloadAudio(tools, {
    url,
    outputDir,
    bitrate,
    noPlaylist: true,
    cancelToken: youtubeCancel,
    cookiesBrowser: settings.youtubeCookiesBrowser,
    onProgress: (payload) => send('youtube:event', { type: 'download', ...payload }),
  });
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('youtube:downloadVideo', async (_event, { url, outputDir, quality }) => {
  const tools = await getTools();
  const settings = publicSettings();
  youtubeCancel = createCancelToken();
  const result = await downloadVideo(tools, {
    url,
    outputDir,
    quality,
    cancelToken: youtubeCancel,
    cookiesBrowser: settings.youtubeCookiesBrowser,
    onProgress: (payload) => send('youtube:event', { type: 'download', ...payload }),
  });
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('youtube:cancel', async () => {
  requestCancel(youtubeCancel);
  send('youtube:event', { type: 'cancelled' });
  return true;
});

ipcMain.handle('bot:connect', async (_event, options) => {
  const tools = await getTools();
  const settings = publicSettings();
  if (botController) {
    botController.stop();
  }
  botController = new TelegramBotController({
    token: options.token,
    tools,
    bitrate: options.bitrate,
    maxFileMb: options.maxFileMb,
    lockFirstChat: Boolean(options.lockFirstChat),
    cookiesBrowser: settings.youtubeCookiesBrowser,
    sendEvent: (payload) => send('bot:event', payload),
  });
  try {
    const info = await botController.start();
    return info;
  } catch (error) {
    botController = null;
    throw error;
  }
});

ipcMain.handle('bot:disconnect', async () => {
  if (botController) {
    botController.stop();
    botController = null;
  }
  return true;
});
