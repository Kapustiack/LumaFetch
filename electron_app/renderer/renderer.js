const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

const state = {
  localFiles: [],
  localStatuses: new Map(),
  youtubeMode: 'audio',
  youtubeBusy: false,
  botConnected: false,
  settings: {},
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

function setText(selector, text) {
  $(selector).textContent = text;
}

function setBusy(button, busy, text = 'Working...') {
  button.disabled = busy;
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.textContent = busy ? text : button.dataset.originalText;
}

function showPanel(name) {
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === name));
  if (name === 'settings') refreshDiagnostics();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUrls(text) {
  return [...String(text || '').matchAll(URL_RE)].map((match) => match[0].replace(/[.,;:!?)\]"']+$/g, ''));
}

function formatBytes(bytes) {
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

function friendlyError(error) {
  const message = error && error.message ? error.message : String(error);
  if (/cancelled/i.test(message)) return 'Cancelled.';
  if (/sign in to confirm|not a bot|cookies-from-browser|youtube.*bot/i.test(message)) {
    return 'YouTube asked for sign-in or bot verification. Pick a cookies browser in Settings, then try again.';
  }
  if (/private|members-only|unavailable|copyright|removed|restricted/i.test(message)) {
    return 'That item is private, unavailable, removed, or restricted.';
  }
  if (/enoent|spawn .*yt-dlp/i.test(message)) {
    return 'yt-dlp was not found. Open Settings, refresh Tools, or run Install all from the setup window.';
  }
  if (/ffmpeg/i.test(message) && /missing|enoent|spawn/i.test(message)) {
    return 'ffmpeg was not found. Open Settings, refresh Tools, or run Install all from the setup window.';
  }
  return message.replace(/\s+/g, ' ').slice(0, 260);
}

function toast(title, detail = '', type = 'info') {
  const host = $('#toastHost');
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
  host.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    setTimeout(() => item.remove(), 220);
  }, 5200);
}

function renderLocalFiles() {
  const list = $('#localList');
  list.innerHTML = '';
  if (!state.localFiles.length) {
    list.innerHTML = '<div class="file-row"><div><div class="file-name">No files selected</div><div class="file-path">Add files or folders</div></div><span class="pill">Idle</span></div>';
  } else {
    for (const filePath of state.localFiles) {
      const status = state.localStatuses.get(filePath) || 'Waiting';
      const row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML = `
        <div>
          <div class="file-name">${escapeHtml(basename(filePath))}</div>
          <div class="file-path">${escapeHtml(filePath)}</div>
        </div>
        <span class="pill">${escapeHtml(status)}</span>
      `;
      list.appendChild(row);
    }
  }
  setText('#localCount', `${state.localFiles.length} file${state.localFiles.length === 1 ? '' : 's'}`);
}

function addLocalFiles(files) {
  const seen = new Set(state.localFiles.map((item) => item.toLowerCase()));
  for (const filePath of files || []) {
    if (!seen.has(filePath.toLowerCase())) {
      seen.add(filePath.toLowerCase());
      state.localFiles.push(filePath);
      state.localStatuses.set(filePath, 'Waiting');
    }
  }
  renderLocalFiles();
}

function setYoutubeMode(mode) {
  state.youtubeMode = mode;
  $$('.mode-button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  $$('.audio-only').forEach((element) => element.classList.toggle('hidden', mode !== 'audio'));
  $$('.video-only').forEach((element) => element.classList.toggle('hidden', mode !== 'video'));
  $('.fetch-form').classList.toggle('video-mode', mode === 'video');
}

function setYoutubeBusy(busy) {
  state.youtubeBusy = busy;
  $('#youtubeDownload').disabled = busy;
  $('#youtubeAnalyze').disabled = busy;
  $('#youtubeCancel').disabled = !busy;
}

function setSetupVisible(visible) {
  $('#setupOverlay').classList.toggle('hidden', !visible);
}

function addActivity(title, detail, status) {
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML = `
    <div>
      <div class="activity-main">${escapeHtml(title)}</div>
      <div class="activity-sub">${escapeHtml(detail)}</div>
    </div>
    <span class="pill">${escapeHtml(status)}</span>
  `;
  $('#botActivity').prepend(row);
  return row;
}

async function chooseOutput(input) {
  const folder = await window.lumaFetch.selectOutputFolder();
  if (folder) input.value = folder;
}

function chooseSelectValue(select, value) {
  if (!value) return;
  const exists = [...select.options].some((option) => option.value === value || option.textContent === value);
  if (exists) select.value = value;
}

function applyTheme(theme) {
  const requested = theme || 'dark';
  const resolved = requested === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : requested;
  document.documentElement.dataset.theme = resolved;
}

function applySettings(settings) {
  state.settings = settings || {};
  applyTheme(state.settings.theme);

  $('#settingsTheme').value = state.settings.theme || 'dark';
  $('#settingsOutput').value = state.settings.defaultOutputDir || '';
  $('#settingsCookieBrowser').value = state.settings.youtubeCookiesBrowser || '';
  $('#settingsMaxMb').value = state.settings.telegramMaxMb || 50;
  $('#settingsLockChat').checked = state.settings.telegramLockChat !== false;
  $('#settingsAutoUpdate').checked = state.settings.autoUpdate !== false;
  chooseSelectValue($('#settingsAudioQuality'), state.settings.defaultAudioQuality || '192k');
  chooseSelectValue($('#settingsVideoQuality'), state.settings.defaultVideoQuality || 'best');

  if (state.settings.defaultOutputDir) {
    if (!$('#localOutput').value) $('#localOutput').value = state.settings.defaultOutputDir;
    if (!$('#youtubeOutput').value) $('#youtubeOutput').value = state.settings.defaultOutputDir;
  }
  chooseSelectValue($('#localQuality'), state.settings.defaultAudioQuality || '192k');
  chooseSelectValue($('#youtubeAudioQuality'), state.settings.defaultAudioQuality || '192k');
  chooseSelectValue($('#botQuality'), state.settings.defaultAudioQuality || '192k');
  $('#botMaxMb').value = state.settings.telegramMaxMb || 50;
  $('#botLock').checked = state.settings.telegramLockChat !== false;
}

function collectSettings() {
  return {
    theme: $('#settingsTheme').value,
    defaultOutputDir: $('#settingsOutput').value,
    defaultAudioQuality: $('#settingsAudioQuality').value,
    defaultVideoQuality: $('#settingsVideoQuality').value,
    telegramMaxMb: Number($('#settingsMaxMb').value || 50),
    telegramLockChat: $('#settingsLockChat').checked,
    youtubeCookiesBrowser: $('#settingsCookieBrowser').value,
    autoUpdate: $('#settingsAutoUpdate').checked,
  };
}

async function loadSettings() {
  try {
    const settings = await window.lumaFetch.getSettings();
    applySettings(settings);
  } catch (error) {
    toast('Settings failed', friendlyError(error), 'error');
  }
}

async function saveSettings() {
  $('#settingsSave').disabled = true;
  try {
    const settings = await window.lumaFetch.saveSettings(collectSettings());
    applySettings(settings);
    setText('#settingsHint', 'Saved');
    toast('Settings saved', 'Defaults will be used on future launches.');
    await refreshDiagnostics();
  } catch (error) {
    setText('#settingsHint', 'Save failed');
    toast('Settings failed', friendlyError(error), 'error');
  } finally {
    $('#settingsSave').disabled = false;
  }
}

function renderDiagnostics(diag) {
  const deps = diag.dependencyStatus || {};
  const lines = [
    `LumaFetch ${diag.appVersion}`,
    `Tools: ${deps.ok ? 'Ready' : `Missing ${((deps.missing || []).join(', ') || 'unknown')}`}`,
    `yt-dlp: ${deps.ytdlp ? `${deps.ytdlp.mode} - ${deps.ytdlp.source}` : 'missing'}`,
    `ffmpeg: ${deps.ffmpegPath || 'missing'}`,
    `Python: ${deps.python || 'not used'}`,
    `Cookies: ${(diag.settings && diag.settings.youtubeCookiesBrowser) || 'none'}`,
    `Auto updates: ${diag.updates && diag.updates.available ? (diag.updates.configured ? 'configured' : 'dev mode') : 'unavailable'}`,
    `User data: ${diag.userData}`,
    `Temp: ${diag.tempDir}`,
    `Last cleanup: ${(diag.settings && diag.settings.lastTempCleanupAt) || 'never'}`,
  ];
  $('#settingsDiagnostics').textContent = lines.join('\n');
}

async function refreshDiagnostics() {
  if (!$('#settingsDiagnostics')) return;
  try {
    $('#settingsDiagnostics').textContent = 'Refreshing diagnostics...';
    renderDiagnostics(await window.lumaFetch.getDiagnostics());
  } catch (error) {
    $('#settingsDiagnostics').textContent = friendlyError(error);
  }
}

async function loadSavedBotToken() {
  try {
    const saved = await window.lumaFetch.getSavedBotToken();
    if (saved && saved.token) {
      $('#botToken').value = saved.token;
      setText('#botHint', 'Saved token loaded');
    }
  } catch (error) {
    setText('#botHint', friendlyError(error));
  }
}

async function checkDependenciesOnLaunch() {
  const startedAt = Date.now();
  setSetupVisible(true);
  $('#setupInstall').disabled = true;
  $('#setupRetry').disabled = true;
  $('#setupProgress').value = 4;
  setText('#toolStatus', 'Checking...');
  setText('#setupStatus', 'Checking ffmpeg and yt-dlp...');
  try {
    const status = await window.lumaFetch.checkDependencies();
    if (status.ok) {
      await sleep(Math.max(0, 1400 - (Date.now() - startedAt)));
      $('#setupProgress').value = 100;
      setText('#setupStatus', 'Everything is ready.');
      setText('#toolStatus', 'Ready');
      setTimeout(() => setSetupVisible(false), 650);
      return;
    }
    $('#setupProgress').value = 0;
    setText('#setupStatus', `Missing: ${status.missing.join(', ')}. Install them now.`);
    setText('#toolStatus', `Missing ${status.missing.join(', ')}`);
    $('#setupInstall').disabled = false;
    $('#setupRetry').disabled = false;
  } catch (error) {
    $('#setupProgress').value = 0;
    setText('#setupStatus', friendlyError(error));
    setText('#toolStatus', 'Check failed');
    $('#setupInstall').disabled = false;
    $('#setupRetry').disabled = false;
  } finally {
    refreshDiagnostics();
  }
}

function wireTabs() {
  $$('.nav-button').forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.tab));
  });
  $$('.mode-button').forEach((button) => {
    button.addEventListener('click', () => setYoutubeMode(button.dataset.mode));
  });
}

function wireSetup() {
  $('#setupRetry').addEventListener('click', checkDependenciesOnLaunch);
  $('#setupInstall').addEventListener('click', async () => {
    $('#setupInstall').disabled = true;
    $('#setupRetry').disabled = true;
    $('#setupProgress').value = 1;
    setText('#setupStatus', 'Starting installation...');
    try {
      const status = await window.lumaFetch.installDependencies();
      if (status.ok) {
        $('#setupProgress').value = 100;
        setText('#setupStatus', 'Installed. LumaFetch is ready.');
        setText('#toolStatus', 'Ready');
        toast('Tools installed', 'ffmpeg and yt-dlp are ready.');
        setTimeout(() => setSetupVisible(false), 650);
      } else {
        setText('#setupStatus', `Still missing: ${status.missing.join(', ')}`);
        setText('#toolStatus', `Missing ${status.missing.join(', ')}`);
        $('#setupInstall').disabled = false;
        $('#setupRetry').disabled = false;
      }
    } catch (error) {
      setText('#setupStatus', friendlyError(error));
      toast('Install failed', friendlyError(error), 'error');
      $('#setupInstall').disabled = false;
      $('#setupRetry').disabled = false;
    } finally {
      refreshDiagnostics();
    }
  });
  window.lumaFetch.onDependencyEvent((event) => {
    $('#setupProgress').value = event.percent || 0;
    setText('#setupStatus', event.message || 'Installing...');
    setText('#toolStatus', event.message || 'Installing...');
  });
}

function wireLocal() {
  $('#localAddFiles').addEventListener('click', async () => {
    addLocalFiles(await window.lumaFetch.selectFiles());
  });
  $('#localAddFolder').addEventListener('click', async () => {
    const folder = await window.lumaFetch.selectFolder();
    if (!folder) return;
    setText('#localStatus', 'Scanning...');
    const files = await window.lumaFetch.scanFolder({
      folder,
      recursive: $('#localRecursive').checked,
    });
    addLocalFiles(files);
    setText('#localStatus', 'Idle');
    toast('Folder scanned', `${files.length} media file${files.length === 1 ? '' : 's'} added.`);
  });
  $('#localClear').addEventListener('click', () => {
    state.localFiles = [];
    state.localStatuses.clear();
    $('#localCurrentProgress').value = 0;
    $('#localOverallProgress').value = 0;
    setText('#localStatus', 'Idle');
    renderLocalFiles();
  });
  $('#localOutputBrowse').addEventListener('click', () => chooseOutput($('#localOutput')));
  $('#localStart').addEventListener('click', async () => {
    if (!state.localFiles.length) return setText('#localStatus', 'Add media first');
    if (!$('#localOutput').value) return setText('#localStatus', 'Choose output');
    $('#localStart').disabled = true;
    $('#localCancel').disabled = false;
    setText('#localStatus', 'Starting...');
    try {
      const result = await window.lumaFetch.convertLocal({
        files: state.localFiles,
        outputDir: $('#localOutput').value,
        bitrate: $('#localQuality').value,
      });
      if (result.ok) toast('Conversion complete', `${result.files.length} file${result.files.length === 1 ? '' : 's'} converted.`);
    } catch (error) {
      setText('#localStatus', friendlyError(error));
      toast('Conversion failed', friendlyError(error), 'error');
    } finally {
      $('#localStart').disabled = false;
      $('#localCancel').disabled = true;
    }
  });
  $('#localCancel').addEventListener('click', () => {
    setText('#localStatus', 'Cancelling...');
    window.lumaFetch.cancelLocal();
  });

  const dropTarget = $('.queue-card');
  $('#local').addEventListener('dragover', (event) => {
    event.preventDefault();
    dropTarget.classList.add('drag-over');
  });
  $('#local').addEventListener('dragleave', () => dropTarget.classList.remove('drag-over'));
  $('#local').addEventListener('drop', async (event) => {
    event.preventDefault();
    dropTarget.classList.remove('drag-over');
    const paths = [...event.dataTransfer.files].map((file) => file.path).filter(Boolean);
    if (!paths.length) return;
    setText('#localStatus', 'Scanning dropped items...');
    try {
      const files = await window.lumaFetch.collectMediaPaths({
        paths,
        recursive: $('#localRecursive').checked,
      });
      addLocalFiles(files);
      setText('#localStatus', 'Idle');
      toast('Dropped items added', `${files.length} media file${files.length === 1 ? '' : 's'} ready.`);
    } catch (error) {
      setText('#localStatus', friendlyError(error));
      toast('Drop failed', friendlyError(error), 'error');
    }
  });

  window.lumaFetch.onLocalEvent((event) => {
    if (event.type === 'item') {
      state.localStatuses.set(event.inputPath, event.status);
      setText('#localStatus', `${event.index}/${event.total}: ${basename(event.inputPath)}`);
      renderLocalFiles();
    }
    if (event.type === 'progress') {
      $('#localCurrentProgress').value = event.current || 0;
      $('#localOverallProgress').value = event.overall || 0;
    }
    if (event.type === 'done') {
      state.localStatuses.set(event.inputPath, 'Done');
      renderLocalFiles();
    }
    if (event.type === 'failed') {
      state.localStatuses.set(event.inputPath, 'Failed');
      setText('#localStatus', friendlyError(event.error));
      renderLocalFiles();
    }
    if (event.type === 'complete') {
      $('#localOverallProgress').value = 100;
      setText('#localStatus', 'Complete');
    }
    if (event.type === 'cancelled') {
      setText('#localStatus', 'Cancelled');
      toast('Conversion cancelled');
    }
  });
}

function wireYoutube() {
  $('#youtubeOutputBrowse').addEventListener('click', () => chooseOutput($('#youtubeOutput')));
  async function runAnalyze() {
    const urls = extractUrls($('#youtubeUrl').value);
    if (!urls.length) return setText('#youtubeStatus', 'Paste a link');
    setBusy($('#youtubeAnalyze'), true, 'Analyzing...');
    setText('#youtubeStatus', urls.length > 1 ? 'Analyzing first link...' : 'Analyzing...');
    try {
      const info = await window.lumaFetch.analyzeYoutube({ url: urls[0] });
      setText('#youtubeTitle', info.title);
      const select = $('#youtubeVideoQuality');
      select.innerHTML = '';
      for (const quality of info.qualities) {
        const option = document.createElement('option');
        option.value = quality.label;
        option.textContent = quality.label;
        select.appendChild(option);
      }
      chooseSelectValue(select, state.settings.defaultVideoQuality || 'best');
      setText('#youtubeStatus', info.qualities.length ? `${info.qualities.length} qualities found` : 'No video qualities found');
    } catch (error) {
      setText('#youtubeStatus', friendlyError(error));
      toast('Analyze failed', friendlyError(error), 'error');
    } finally {
      setBusy($('#youtubeAnalyze'), false);
    }
  }

  async function downloadOneAudio(url, outputDir, playlist, index, total) {
    setText('#youtubeTitle', total > 1 ? `Audio ${index}/${total}` : 'Audio download');
    setText('#youtubeStatus', url);
    $('#youtubeProgress').value = 0;
    return window.lumaFetch.downloadYoutubeAudio({
      url,
      outputDir,
      bitrate: $('#youtubeAudioQuality').value,
      playlist,
    });
  }

  async function downloadOneVideo(url, outputDir, index, total) {
    const quality = $('#youtubeVideoQuality').value || state.settings.defaultVideoQuality || 'best';
    setText('#youtubeTitle', total > 1 ? `Video ${index}/${total}` : 'Video download');
    setText('#youtubeStatus', `${quality} - ${url}`);
    $('#youtubeProgress').value = 0;
    return window.lumaFetch.downloadYoutubeVideo({
      url,
      outputDir,
      quality,
    });
  }

  $('#youtubeAnalyze').addEventListener('click', runAnalyze);
  $('#youtubeDownload').addEventListener('click', async () => {
    const urls = extractUrls($('#youtubeUrl').value);
    const outputDir = $('#youtubeOutput').value;
    if (!urls.length) return setText('#youtubeStatus', 'Paste a link');
    if (!outputDir) return setText('#youtubeStatus', 'Choose output');
    setYoutubeBusy(true);
    $('#youtubeProgress').value = 0;
    let completed = 0;
    let failed = 0;
    try {
      for (let index = 0; index < urls.length; index += 1) {
        try {
          if (state.youtubeMode === 'audio') {
            await downloadOneAudio(urls[index], outputDir, $('#youtubePlaylist').checked, index + 1, urls.length);
          } else {
            await downloadOneVideo(urls[index], outputDir, index + 1, urls.length);
          }
          completed += 1;
        } catch (error) {
          if (/cancelled/i.test(String(error.message || error))) throw error;
          failed += 1;
          toast('Download skipped', friendlyError(error), 'error');
        }
      }
      setText('#youtubeTitle', 'Complete');
      setText('#youtubeStatus', failed ? `${completed} complete, ${failed} failed` : `${completed} complete`);
      toast('Download finished', failed ? `${completed} complete, ${failed} failed` : `${completed} file${completed === 1 ? '' : 's'} saved.`);
    } catch (error) {
      setText('#youtubeStatus', friendlyError(error));
      toast('Download stopped', friendlyError(error), /cancelled/i.test(String(error.message || error)) ? 'info' : 'error');
    } finally {
      setYoutubeBusy(false);
    }
  });
  $('#youtubeCancel').addEventListener('click', () => {
    setText('#youtubeStatus', 'Cancelling...');
    window.lumaFetch.cancelYoutube();
  });

  window.lumaFetch.onYoutubeEvent((event) => {
    if (event.type === 'download') {
      setText('#youtubeStatus', `${event.stage}${event.percent == null ? '' : ` ${event.percent.toFixed(1)}%`}`);
      if (event.percent != null) $('#youtubeProgress').value = event.percent;
    }
    if (event.type === 'playlist-check') {
      setText('#youtubeTitle', `Checking ${event.index}/${event.total}`);
      setText('#youtubeStatus', event.title);
    }
    if (event.type === 'playlist-ready') {
      setText('#youtubeTitle', `Playlist: ${event.available}/${event.total}`);
      setText('#youtubeStatus', `${event.unavailable} unavailable`);
    }
    if (event.type === 'playlist-item') {
      setText('#youtubeTitle', `${event.index}/${event.total}`);
      setText('#youtubeStatus', event.title);
      $('#youtubeProgress').value = 0;
    }
    if (event.type === 'cancelled') {
      setText('#youtubeStatus', 'Cancelled');
    }
  });
}

function wireBot() {
  $('#botSaveToken').addEventListener('click', async () => {
    $('#botSaveToken').disabled = true;
    try {
      const result = await window.lumaFetch.saveBotToken({ token: $('#botToken').value.trim() });
      setText('#botHint', result.saved ? 'Token saved' : 'Saved token cleared');
      toast(result.saved ? 'Token saved' : 'Token cleared');
    } catch (error) {
      setText('#botHint', friendlyError(error));
      toast('Token save failed', friendlyError(error), 'error');
    } finally {
      $('#botSaveToken').disabled = false;
    }
  });
  $('#botConnect').addEventListener('click', async () => {
    if (!$('#botToken').value.trim()) return setText('#botStatus', 'Token required');
    $('#botConnect').disabled = true;
    setText('#botStatus', 'Connecting...');
    try {
      const result = await window.lumaFetch.connectBot({
        token: $('#botToken').value.trim(),
        bitrate: $('#botQuality').value,
        maxFileMb: Number($('#botMaxMb').value || 50),
        lockFirstChat: $('#botLock').checked,
      });
      state.botConnected = true;
      setText('#botStatus', `Connected as @${result.username}`);
      $('#botDisconnect').disabled = false;
      $('#botToken').disabled = true;
      $('#botQuality').disabled = true;
      $('#botMaxMb').disabled = true;
      $('#botLock').disabled = true;
      $('#botSaveToken').disabled = true;
      toast('Telegram connected', `@${result.username}`);
    } catch (error) {
      setText('#botStatus', friendlyError(error));
      toast('Bot connection failed', friendlyError(error), 'error');
      $('#botConnect').disabled = false;
    }
  });
  $('#botDisconnect').addEventListener('click', async () => {
    await window.lumaFetch.disconnectBot();
    state.botConnected = false;
    $('#botConnect').disabled = false;
    $('#botDisconnect').disabled = true;
    $('#botToken').disabled = false;
    $('#botQuality').disabled = false;
    $('#botMaxMb').disabled = false;
    $('#botLock').disabled = false;
    $('#botSaveToken').disabled = false;
    setText('#botStatus', 'Disconnected');
    setText('#botChat', 'No chat locked');
    toast('Telegram disconnected');
  });

  window.lumaFetch.onBotEvent((event) => {
    if (event.type === 'status') setText('#botStatus', event.text);
    if (event.type === 'chat') setText('#botChat', `Chat ${event.chatId}`);
    if (event.type === 'job') {
      const job = event.job || {};
      addActivity(event.status, job.url || job.title || job.type || '', job.type || 'bot');
    }
  });
}

function wireSettings() {
  $('#settingsSave').addEventListener('click', saveSettings);
  $('#settingsOutputBrowse').addEventListener('click', () => chooseOutput($('#settingsOutput')));
  $('#settingsTheme').addEventListener('change', () => applyTheme($('#settingsTheme').value));
  $('#settingsRefreshDiag').addEventListener('click', refreshDiagnostics);
  $('#settingsCleanTemp').addEventListener('click', async () => {
    try {
      const result = await window.lumaFetch.cleanTempFiles();
      toast('Temp cleaned', `${result.removed} folder${result.removed === 1 ? '' : 's'}, ${formatBytes(result.freedBytes)} freed.`);
      await refreshDiagnostics();
    } catch (error) {
      toast('Cleanup failed', friendlyError(error), 'error');
    }
  });
  $('#settingsUpdateCheck').addEventListener('click', async () => {
    try {
      const result = await window.lumaFetch.checkForUpdates();
      toast(result.ok ? 'Update check started' : 'Update check unavailable', result.message || 'Watching GitHub Releases.');
    } catch (error) {
      toast('Update check failed', friendlyError(error), 'error');
    }
  });

  window.lumaFetch.onUpdateEvent((event) => {
    if (event.type === 'error') toast('Update check failed', event.message, 'error');
    else toast('Updates', event.message || 'Update status changed.');
  });

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  systemTheme.addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme('system');
  });
}

async function init() {
  wireSetup();
  wireTabs();
  wireLocal();
  wireYoutube();
  wireBot();
  wireSettings();
  renderLocalFiles();
  setYoutubeMode('audio');
  await loadSettings();
  await loadSavedBotToken();
  checkDependenciesOnLaunch();
}

init();
