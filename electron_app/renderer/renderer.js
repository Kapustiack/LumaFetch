const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  localFiles: [],
  localStatuses: new Map(),
  youtubeMode: 'audio',
  botConnected: false,
};

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

function setText(selector, text) {
  $(selector).textContent = text;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.textContent = busy ? 'Working...' : button.dataset.originalText;
}

function showPanel(name) {
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === name));
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
          <div class="file-name">${basename(filePath)}</div>
          <div class="file-path">${filePath}</div>
        </div>
        <span class="pill">${status}</span>
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
  $('#youtubeDownload').disabled = busy;
  $('#youtubeAnalyze').disabled = busy;
  $('#youtubeCancel').disabled = !busy;
}

function setSetupVisible(visible) {
  $('#setupOverlay').classList.toggle('hidden', !visible);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const status = await window.mediaForge.checkDependencies();
    if (status.ok) {
      await sleep(Math.max(0, 2000 - (Date.now() - startedAt)));
      $('#setupProgress').value = 100;
      setText('#setupStatus', 'Everything is ready.');
      setText('#toolStatus', 'Ready');
      setTimeout(() => setSetupVisible(false), 850);
      return;
    }
    $('#setupProgress').value = 0;
    setText('#setupStatus', `Missing: ${status.missing.join(', ')}. Install them now.`);
    setText('#toolStatus', `Missing ${status.missing.join(', ')}`);
    $('#setupInstall').disabled = false;
    $('#setupRetry').disabled = false;
  } catch (error) {
    $('#setupProgress').value = 0;
    setText('#setupStatus', error.message);
    setText('#toolStatus', 'Check failed');
    $('#setupInstall').disabled = false;
    $('#setupRetry').disabled = false;
  }
}

function addActivity(title, detail, status) {
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML = `
    <div>
      <div class="activity-main">${title}</div>
      <div class="activity-sub">${detail}</div>
    </div>
    <span class="pill">${status}</span>
  `;
  $('#botActivity').prepend(row);
  return row;
}

async function chooseOutput(input) {
  const folder = await window.mediaForge.selectOutputFolder();
  if (folder) input.value = folder;
}

async function loadSavedBotToken() {
  try {
    const saved = await window.mediaForge.getSavedBotToken();
    if (saved && saved.token) {
      $('#botToken').value = saved.token;
      setText('#botHint', 'Saved token loaded');
    }
  } catch (error) {
    setText('#botHint', error.message);
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
      const status = await window.mediaForge.installDependencies();
      if (status.ok) {
        $('#setupProgress').value = 100;
        setText('#setupStatus', 'Installed. LumaFetch is ready.');
        setText('#toolStatus', 'Ready');
        setTimeout(() => setSetupVisible(false), 650);
      } else {
        setText('#setupStatus', `Still missing: ${status.missing.join(', ')}`);
        setText('#toolStatus', `Missing ${status.missing.join(', ')}`);
        $('#setupInstall').disabled = false;
        $('#setupRetry').disabled = false;
      }
    } catch (error) {
      setText('#setupStatus', error.message);
      $('#setupInstall').disabled = false;
      $('#setupRetry').disabled = false;
    }
  });
  window.mediaForge.onDependencyEvent((event) => {
    $('#setupProgress').value = event.percent || 0;
    setText('#setupStatus', event.message || 'Installing...');
    setText('#toolStatus', event.message || 'Installing...');
  });
}

function wireLocal() {
  $('#localAddFiles').addEventListener('click', async () => {
    addLocalFiles(await window.mediaForge.selectFiles());
  });
  $('#localAddFolder').addEventListener('click', async () => {
    const folder = await window.mediaForge.selectFolder();
    if (!folder) return;
    setText('#localStatus', 'Scanning...');
    const files = await window.mediaForge.scanFolder({
      folder,
      recursive: $('#localRecursive').checked,
    });
    addLocalFiles(files);
    setText('#localStatus', 'Idle');
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
      await window.mediaForge.convertLocal({
        files: state.localFiles,
        outputDir: $('#localOutput').value,
        bitrate: $('#localQuality').value,
      });
    } catch (error) {
      setText('#localStatus', error.message);
    } finally {
      $('#localStart').disabled = false;
      $('#localCancel').disabled = true;
    }
  });
  $('#localCancel').addEventListener('click', () => {
    setText('#localStatus', 'Cancelling...');
    window.mediaForge.cancelLocal();
  });

  window.mediaForge.onLocalEvent((event) => {
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
      setText('#localStatus', event.error);
      renderLocalFiles();
    }
    if (event.type === 'complete') {
      $('#localOverallProgress').value = 100;
      setText('#localStatus', 'Complete');
    }
    if (event.type === 'cancelled') {
      setText('#localStatus', 'Cancelled');
    }
  });
}

function wireYoutube() {
  $('#youtubeOutputBrowse').addEventListener('click', () => chooseOutput($('#youtubeOutput')));
  async function runAnalyze() {
    const url = $('#youtubeUrl').value.trim();
    if (!url) return setText('#youtubeStatus', 'Paste a link');
    setBusy($('#youtubeAnalyze'), true);
    setText('#youtubeStatus', 'Analyzing...');
    try {
      const info = await window.mediaForge.analyzeYoutube({ url });
      setText('#youtubeTitle', info.title);
      const select = $('#youtubeVideoQuality');
      select.innerHTML = '';
      for (const quality of info.qualities) {
        const option = document.createElement('option');
        option.value = quality.label;
        option.textContent = quality.label;
        select.appendChild(option);
      }
      setText('#youtubeStatus', info.qualities.length ? `${info.qualities.length} qualities found` : 'No video qualities found');
    } catch (error) {
      setText('#youtubeStatus', error.message);
    } finally {
      setBusy($('#youtubeAnalyze'), false);
    }
  }
  $('#youtubeAnalyze').addEventListener('click', runAnalyze);
  $('#youtubeDownload').addEventListener('click', async () => {
    const url = $('#youtubeUrl').value.trim();
    const outputDir = $('#youtubeOutput').value;
    if (!url) return setText('#youtubeStatus', 'Paste a link');
    if (!outputDir) return setText('#youtubeStatus', 'Choose output');
    setYoutubeBusy(true);
    $('#youtubeProgress').value = 0;
    try {
      if (state.youtubeMode === 'audio') {
        await window.mediaForge.downloadYoutubeAudio({
          url,
          outputDir,
          bitrate: $('#youtubeAudioQuality').value,
          playlist: $('#youtubePlaylist').checked,
        });
      } else {
        if (!$('#youtubeVideoQuality').value) {
          setText('#youtubeStatus', 'Analyze video first');
          return;
        }
        await window.mediaForge.downloadYoutubeVideo({
          url,
          outputDir,
          quality: $('#youtubeVideoQuality').value || 'best',
        });
      }
      setText('#youtubeStatus', 'Complete');
    } catch (error) {
      setText('#youtubeStatus', error.message);
    } finally {
      setYoutubeBusy(false);
    }
  });
  $('#youtubeCancel').addEventListener('click', () => {
    setText('#youtubeStatus', 'Cancelling...');
    window.mediaForge.cancelYoutube();
  });

  window.mediaForge.onYoutubeEvent((event) => {
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
      const result = await window.mediaForge.saveBotToken({ token: $('#botToken').value.trim() });
      setText('#botHint', result.saved ? 'Token saved' : 'Saved token cleared');
    } catch (error) {
      setText('#botHint', error.message);
    } finally {
      $('#botSaveToken').disabled = false;
    }
  });
  $('#botConnect').addEventListener('click', async () => {
    if (!$('#botToken').value.trim()) return setText('#botStatus', 'Token required');
    $('#botConnect').disabled = true;
    setText('#botStatus', 'Connecting...');
    try {
      const result = await window.mediaForge.connectBot({
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
    } catch (error) {
      setText('#botStatus', error.message);
      $('#botConnect').disabled = false;
    }
  });
  $('#botDisconnect').addEventListener('click', async () => {
    await window.mediaForge.disconnectBot();
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
  });

  window.mediaForge.onBotEvent((event) => {
    if (event.type === 'status') setText('#botStatus', event.text);
    if (event.type === 'chat') setText('#botChat', `Chat ${event.chatId}`);
    if (event.type === 'job') {
      const job = event.job || {};
      addActivity(event.status, job.url || job.title || job.type || '', job.type || 'bot');
    }
  });
}

function init() {
  wireSetup();
  wireTabs();
  wireLocal();
  wireYoutube();
  wireBot();
  renderLocalFiles();
  setYoutubeMode('audio');
  loadSavedBotToken();
  checkDependenciesOnLaunch();
}

init();
