const { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { createCancelToken, requestCancel } = require('./core/cancel');
const { findTools, checkDependencies, installDependencies } = require('./core/tools');
const { collectMediaFiles, convertBatch } = require('./core/converter');
const {
  analyzeVideo,
  downloadAudio,
  downloadVideo,
  getPlaylistFlat,
  checkPlaylistItems,
} = require('./core/ytdlp');
const { TelegramBotController } = require('./core/telegramBot');

let mainWindow;
let toolsPromise;
let localCancel = createCancelToken();
let youtubeCancel = createCancelToken();
let botController = null;

app.setName('LumaFetch');

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

app.whenReady().then(createWindow);

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

ipcMain.handle('bot:getSavedToken', async () => {
  return { token: readSavedBotToken() };
});

ipcMain.handle('bot:saveToken', async (_event, { token }) => {
  return saveBotToken(token);
});

ipcMain.handle('local:scanFolder', async (_event, { folder, recursive }) => {
  return collectMediaFiles([folder], Boolean(recursive));
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
  youtubeCancel = createCancelToken();
  return analyzeVideo(tools, url, youtubeCancel);
});

ipcMain.handle('youtube:downloadAudio', async (_event, { url, outputDir, bitrate, playlist }) => {
  const tools = await getTools();
  youtubeCancel = createCancelToken();
  if (playlist) {
    const flat = await getPlaylistFlat(tools, url, youtubeCancel);
    if (youtubeCancel.cancelled) throw new Error('Cancelled');
    const checked = await checkPlaylistItems(tools, flat.entries, {
      cancelToken: youtubeCancel,
      onProgress: (payload) => send('youtube:event', { type: 'playlist-check', ...payload }),
    });
    if (youtubeCancel.cancelled) throw new Error('Cancelled');
    send('youtube:event', {
      type: 'playlist-ready',
      total: flat.total,
      available: checked.available.length,
      unavailable: checked.unavailable.length,
    });
    const results = [];
    for (let index = 0; index < checked.available.length; index += 1) {
      if (youtubeCancel.cancelled) break;
      const item = checked.available[index];
      send('youtube:event', {
        type: 'playlist-item',
        index: index + 1,
        total: checked.available.length,
        title: item.title,
      });
      const result = await downloadAudio(tools, {
        url: item.url,
        outputDir,
        bitrate,
        noPlaylist: true,
        cancelToken: youtubeCancel,
        onProgress: (payload) => send('youtube:event', { type: 'download', ...payload }),
      });
      results.push(result);
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
    onProgress: (payload) => send('youtube:event', { type: 'download', ...payload }),
  });
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('youtube:downloadVideo', async (_event, { url, outputDir, quality }) => {
  const tools = await getTools();
  youtubeCancel = createCancelToken();
  const result = await downloadVideo(tools, {
    url,
    outputDir,
    quality,
    cancelToken: youtubeCancel,
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
  if (botController) {
    botController.stop();
  }
  botController = new TelegramBotController({
    token: options.token,
    tools,
    bitrate: options.bitrate,
    maxFileMb: Number(options.maxFileMb || 50),
    lockFirstChat: Boolean(options.lockFirstChat),
    sendEvent: (payload) => send('bot:event', payload),
  });
  const info = await botController.start();
  return info;
});

ipcMain.handle('bot:disconnect', async () => {
  if (botController) {
    botController.stop();
    botController = null;
  }
  return true;
});
