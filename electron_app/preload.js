const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('lumaFetch', {
  selectFiles: () => ipcRenderer.invoke('dialog:files'),
  selectFolder: () => ipcRenderer.invoke('dialog:folder'),
  selectOutputFolder: () => ipcRenderer.invoke('dialog:outputFolder'),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  checkDependencies: () => ipcRenderer.invoke('dependencies:check'),
  installDependencies: () => ipcRenderer.invoke('dependencies:install'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  getDiagnostics: () => ipcRenderer.invoke('settings:diagnostics'),
  cleanTempFiles: () => ipcRenderer.invoke('settings:cleanTemp'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),

  scanFolder: (payload) => ipcRenderer.invoke('local:scanFolder', payload),
  collectMediaPaths: (payload) => ipcRenderer.invoke('local:collectPaths', payload),
  convertLocal: (payload) => ipcRenderer.invoke('local:convert', payload),
  cancelLocal: () => ipcRenderer.invoke('local:cancel'),

  analyzeYoutube: (payload) => ipcRenderer.invoke('youtube:analyze', payload),
  downloadYoutubeAudio: (payload) => ipcRenderer.invoke('youtube:downloadAudio', payload),
  downloadYoutubeVideo: (payload) => ipcRenderer.invoke('youtube:downloadVideo', payload),
  cancelYoutube: () => ipcRenderer.invoke('youtube:cancel'),

  connectBot: (payload) => ipcRenderer.invoke('bot:connect', payload),
  disconnectBot: () => ipcRenderer.invoke('bot:disconnect'),
  getSavedBotToken: () => ipcRenderer.invoke('bot:getSavedToken'),
  saveBotToken: (payload) => ipcRenderer.invoke('bot:saveToken', payload),

  onLocalEvent: (callback) => on('local:event', callback),
  onYoutubeEvent: (callback) => on('youtube:event', callback),
  onBotEvent: (callback) => on('bot:event', callback),
  onDependencyEvent: (callback) => on('dependencies:event', callback),
  onUpdateEvent: (callback) => on('updates:event', callback),
});
