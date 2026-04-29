// ============== Spool — renderer ==============
const api = window.spool;

const state = {
  modes: [],
  voices: [],
  settings: null,
  ytStatus: { connected: false, hasCreds: false },
  channelInfo: null,
  license: { active: false },
  selectedMode: 'topx',
  duration: 60,
  selectedVoice: 'en-US-AriaNeural',
  burnSubs: true,
  generating: false,
  currentProject: null,
  proKeyClicks: 0,
};

const DURATIONS = [
  { sec: 15, label: '15s' },
  { sec: 30, label: '30s' },
  { sec: 60, label: '60s' },
  { sec: 180, label: '3m', pro: true },
  { sec: 300, label: '5m', pro: true },
  { sec: 600, label: '10m', pro: true },
  { sec: 900, label: '15m', pro: true },
  { sec: 1800, label: '30m', pro: true },
];

// ============== Helpers ==============
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
}

function confirmDialog(title, body, okLabel = 'Continue') {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    $('#modal-ok').textContent = okLabel;
    $('#modal').classList.remove('hidden');
    const close = (val) => {
      $('#modal').classList.add('hidden');
      $('#modal-ok').removeEventListener('click', onOk);
      $('#modal-cancel').removeEventListener('click', onCancel);
      resolve(val);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    $('#modal-ok').addEventListener('click', onOk);
    $('#modal-cancel').addEventListener('click', onCancel);
  });
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

async function refreshAutoUploadHint() {
  const vis = state.settings.autoUploadVisibility || 'unlisted';
  const visEl = $('#autoupload-vis');
  if (visEl) visEl.textContent = capitalize(vis);
  const quotaEl = $('#autoupload-quota');
  if (quotaEl) {
    try {
      const s = await api.autoUploadStatus();
      if (s.blocked) quotaEl.textContent = `· quota hit (${s.count}/${s.limit} today)`;
      else if (s.warn) quotaEl.textContent = `· ${s.count}/${s.limit} used today`;
      else quotaEl.textContent = '';
    } catch (_) {}
  }
}

function fmtDuration(s) {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

// ============== Boot ==============
async function boot() {
  // Resolve external links via main
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-href]');
    if (a) { e.preventDefault(); api.openExternal(a.dataset.href); }
  });

  // Pull bootstrap data
  const [modes, settings, ytStatus, license, info] = await Promise.all([
    api.listModes(),
    api.getSettings(),
    api.ytStatus(),
    api.getLicense(),
    api.getAppInfo(),
  ]);
  state.modes = modes;
  state.settings = settings;
  state.ytStatus = ytStatus;
  state.license = license;
  state.selectedMode = settings.defaultMode || 'topx';
  state.duration = settings.defaultDuration || 60;
  state.burnSubs = settings.burnSubtitles ?? true;

  $('#about-version').textContent = `Spool ${info.version}`;

  // Decide: setup wizard or main app?
  if (!settings.setupComplete) {
    showSetup();
  } else {
    showApp();
  }

  bindGlobal();
  bindSetup();
  bindCompose();
  bindLibrary();
  bindQueue();
  bindSlipstream();
  bindSettings();
  applyLicense();
  await refreshChannelPill();
  await loadVoices();
  buildModeCards();
  buildDurationPills();

  // Listeners
  api.onProgress(handleProgress);
  api.onUploadProgress(handleUploadProgress);
  api.onUpdateStatus(handleUpdaterStatus);
  api.onQueueUpdate(() => refreshQueue());
  api.onSlipstreamUpdate(() => refreshSlipstream());
}

// ============== UI builders ==============
function showSetup() { $('#setup').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp()   { $('#setup').classList.add('hidden');   $('#app').classList.remove('hidden'); }

function bindGlobal() {
  $$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'library') refreshLibrary();
  if (name === 'settings') refreshSettingsTab();
  if (name === 'queue') refreshQueue();
  if (name === 'slipstream') refreshSlipstream();
}

// ============== Setup wizard ==============
function bindSetup() {
  let step = 1;
  const showStep = (n) => {
    step = n;
    $$('.setup-step').forEach(el => el.classList.remove('active'));
    $(`#setup-step-${n}`).classList.add('active');
    $$('.step').forEach((el, i) => el.classList.toggle('done', (i + 1) <= n));
  };

  $('#yt-connect-btn').addEventListener('click', async () => {
    $('#yt-status-line').textContent = 'Opening browser…';
    const r = await api.ytStartAuth();
    if (r.ok) {
      $('#yt-status-line').textContent = 'Connected ✓';
      $('#yt-status-line').classList.add('ok');
      state.ytStatus.connected = true;
      await refreshChannelPill();
    } else if (r.error === 'NO_GOOGLE_CREDS') {
      $('#yt-status-line').textContent = 'OAuth credentials missing — set them in Settings → Override Google credentials.';
    } else {
      $('#yt-status-line').textContent = 'Auth failed: ' + r.error;
    }
  });

  $('#yt-skip-btn').addEventListener('click', () => showStep(2));
  $('#step-1-next').addEventListener('click', () => showStep(2));
  $('#step-2-back').addEventListener('click', () => showStep(1));
  $('#step-3-back').addEventListener('click', () => showStep(2));

  $('#step-2-next').addEventListener('click', async () => {
    const k = $('#pexels-key').value.trim();
    if (k) await api.setSecret('pexelsKey', k);
    showStep(3);
  });

  $('#step-3-finish').addEventListener('click', async () => {
    const k = $('#pixabay-key').value.trim();
    if (k) await api.setSecret('pixabayKey', k);
    const hasPexels = await api.hasSecret('pexelsKey');
    const hasPixabay = await api.hasSecret('pixabayKey');
    if (!hasPexels && !hasPixabay) {
      return toast('Add at least one stock-footage key.', 'err');
    }
    await api.setSettings({ setupComplete: true });
    showApp();
    toast('Welcome to Spool.', 'ok');
  });
}

// ============== Compose ==============
function buildModeCards() {
  const grid = $('#modes-grid');
  grid.innerHTML = '';
  for (const m of state.modes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (m.id === state.selectedMode ? ' selected' : '');
    card.dataset.mode = m.id;
    card.innerHTML = `
      ${m.pro ? '<div class="mode-pro">PRO</div>' : ''}
      <div class="mode-name">${m.name}</div>
      <div class="mode-tag">${m.tagline}</div>`;
    card.addEventListener('click', () => {
      if (m.pro && !state.license.active) return toast(`${m.name} is a Pro mode.`, 'err');
      state.selectedMode = m.id;
      $$('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === m.id));
      const mode = state.modes.find(x => x.id === m.id);
      if (mode && state.duration < 60) {
        // keep
      }
    });
    grid.appendChild(card);
  }
}

function buildDurationPills() {
  const row = $('#duration-row');
  row.innerHTML = '';
  for (const d of DURATIONS) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'duration-pill' + (d.sec === state.duration ? ' active' : '') + (d.pro && !state.license.active ? ' locked' : '');
    pill.textContent = d.label;
    pill.addEventListener('click', () => {
      if (d.pro && !state.license.active) return toast('Durations over 60s are Pro.', 'err');
      state.duration = d.sec;
      $$('.duration-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      $('#duration-display').textContent = fmtDuration(d.sec);
    });
    row.appendChild(pill);
  }
  $('#duration-display').textContent = fmtDuration(state.duration);
}

async function loadVoices() {
  const voices = await api.ttsListVoices();
  state.voices = voices;
  // English first, then everything
  const sorted = voices.slice().sort((a, b) => {
    const ae = a.locale?.startsWith('en') ? 0 : 1;
    const be = b.locale?.startsWith('en') ? 0 : 1;
    return ae - be || (a.locale || '').localeCompare(b.locale || '');
  });
  const proList = state.license.active ? sorted : sorted.filter(v => v.locale?.startsWith('en')).slice(0, 10);
  for (const sel of [$('#voice-select'), $('#set-voice')]) {
    if (!sel) continue;
    sel.innerHTML = '';
    for (const v of proList) {
      const opt = document.createElement('option');
      opt.value = v.shortName;
      opt.textContent = `${v.shortName.replace('Neural', '')} • ${v.locale || ''}`;
      sel.appendChild(opt);
    }
    sel.value = state.settings?.voice || state.selectedVoice;
  }
  state.selectedVoice = $('#voice-select').value || state.selectedVoice;
}

function bindCompose() {
  $('#voice-select').addEventListener('change', e => state.selectedVoice = e.target.value);
  $('#opt-subtitles').addEventListener('change', e => state.burnSubs = e.target.checked);

  // Auto-upload toggle — first-time enable shows safety dialog
  const autoBox = $('#opt-autoupload');
  autoBox.checked = !!state.settings.autoUpload;
  refreshAutoUploadHint();
  autoBox.addEventListener('change', async (e) => {
    if (e.target.checked && !state.settings.autoUploadAcknowledged) {
      const ok = await confirmDialog(
        'Enable auto-upload?',
        'Auto-upload will publish videos to your YouTube channel without further confirmation. You can disable it anytime in Settings. Continue?',
        'Enable',
      );
      if (!ok) { e.target.checked = false; return; }
      state.settings.autoUploadAcknowledged = true;
      await api.setSettings({ autoUploadAcknowledged: true });
    }
    if (e.target.checked && !state.ytStatus.connected) {
      e.target.checked = false;
      toast('Connect YouTube in Settings first.', 'err');
      return;
    }
    state.settings.autoUpload = e.target.checked;
    await api.setSettings({ autoUpload: e.target.checked });
    refreshAutoUploadHint();
    if (e.target.checked) {
      const s = await api.autoUploadStatus();
      if (s.blocked) toast('Daily YouTube quota already hit — auto-upload will wait until tomorrow.', 'err');
      else if (s.warn) toast(`Heads up — ${s.count}/${s.limit} uploads used today.`, '');
    }
  });

  $('#voice-preview-btn').addEventListener('click', async () => {
    const r = await api.ttsPreview(state.selectedVoice, 'This is what your voiceover will sound like.');
    if (!r.ok) return toast('TTS unavailable.', 'err');
    const audio = $('#voice-preview-audio');
    audio.src = 'file:///' + r.file.replace(/\\/g, '/');
    audio.play().catch(() => {});
  });

  $('#generate-btn').addEventListener('click', startGenerate);
  $('#cancel-btn').addEventListener('click', async () => {
    await api.cancelGenerate();
    toast('Cancelling…');
  });

  $('#upload-btn').addEventListener('click', uploadCurrent);
}

async function startGenerate() {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { toast('Add a prompt.', 'err'); return; }
  state.generating = true;
  $('#generate-btn').disabled = true;
  $('#generate-btn').textContent = 'Generating…';
  $('#cancel-btn').classList.remove('hidden');
  $('#empty-side').classList.add('hidden');
  $('#progress-card').classList.remove('hidden');
  $('#result-card').classList.add('hidden');
  $('#progress-log').innerHTML = '';
  appendLog('start', `prompt: "${prompt.slice(0, 60)}"`);
  appendLog('start', `mode: ${state.selectedMode}, ${fmtDuration(state.duration)}`);

  const r = await api.generate({
    prompt,
    modeId: state.selectedMode,
    durationSec: state.duration,
    voice: state.selectedVoice,
    burnSubtitles: state.burnSubs,
  });

  state.generating = false;
  $('#generate-btn').disabled = false;
  $('#generate-btn').textContent = 'Generate Video';
  $('#cancel-btn').classList.add('hidden');

  if (!r.ok) {
    appendLog('err', `failed: ${r.error}${r.detail ? ' — ' + r.detail : ''}`);
    toast(r.detail || r.error, 'err');
    return;
  }

  state.currentProject = r.project;
  showResult(r.project);
  appendLog('ok', `done — ${r.project.id}`);

  if (state.settings.autoUpload && state.ytStatus.connected) {
    await runAutoUpload(r.project);
  } else {
    toast('Video ready. Preview, then upload.', 'ok');
  }
}

async function runAutoUpload(project) {
  const visibility = state.settings.autoUploadVisibility || 'unlisted';
  appendLog('start', `auto-upload (${visibility})…`);
  $('#upload-progress').textContent = 'Auto-upload starting…';

  const params = {
    videoPath: project.videoPath,
    thumbPath: project.thumbPath,
    title: (project.script?.title || project.prompt || 'Untitled').slice(0, 100),
    description: (project.script?.description || '').slice(0, 5000),
    tags: project.script?.tags || [],
    privacyStatus: visibility,
  };
  // Sync the metadata fields so the user sees what shipped
  $('#result-title').value = params.title;
  $('#result-description').value = params.description;
  $('#result-privacy').value = visibility;

  const r = await api.autoUploadRun(params);
  if (r.ok) {
    $('#upload-progress').innerHTML = `<a class="link" data-href="${r.url}">${r.url}</a>`;
    appendLog('ok', `uploaded → ${r.url}`);
    toast(`Uploaded as ${capitalize(visibility)}.`, 'ok');
    if (r.warn) toast(`Approaching daily YouTube quota (${r.count}/${r.limit}).`, '');
  } else if (r.error === 'QUOTA_BLOCKED') {
    $('#upload-progress').textContent = `Quota hit — ${r.count}/${r.limit} uploads used today.`;
    appendLog('err', `auto-upload blocked: quota ${r.count}/${r.limit}`);
    toast('Daily YouTube quota hit — try again tomorrow.', 'err');
  } else if (r.error === 'NOT_CONNECTED') {
    $('#upload-progress').textContent = 'Auto-upload skipped — YouTube not connected.';
    toast('YouTube not connected — auto-upload skipped.', 'err');
  } else {
    $('#upload-progress').textContent = `Auto-upload failed: ${r.error}`;
    appendLog('err', `auto-upload failed: ${r.error}`);
    toast(`Auto-upload failed: ${r.error}. Open Library to retry.`, 'err');
  }
  refreshAutoUploadHint();
}

function showResult(project) {
  $('#result-card').classList.remove('hidden');
  const v = $('#result-video');
  v.src = 'file:///' + project.videoPath.replace(/\\/g, '/');
  $('#result-title').value = project.script.title || '';
  $('#result-description').value = project.script.description || '';
  $('#upload-progress').textContent = '';
}

function handleProgress(p) {
  if (!p) return;
  const pctMap = { script: [0, 0.10], clips: [0.10, 0.45], tts: [0.45, 0.65], music: [0.65, 0.70], stitch: [0.70, 0.99], done: [1, 1] };
  const range = pctMap[p.stage] || [0, 1];
  const overall = range[0] + (range[1] - range[0]) * (p.pct || 0);
  $('#progress-fill').style.width = (overall * 100).toFixed(1) + '%';
  $('#progress-percent').textContent = Math.round(overall * 100) + '%';
  const labelMap = {
    script: 'Writing script',
    clips: 'Fetching footage',
    tts: 'Recording voiceover',
    music: 'Selecting music',
    stitch: 'Editing video',
    done: 'Done',
  };
  $('#progress-stage').textContent = (labelMap[p.stage] || p.stage) + (p.message ? ` — ${p.message}` : '');
  if (p.stage === 'script' && p.pct === 1 && p.script) {
    appendLog('ok', `script: ${p.script.scenes?.length || 0} scenes`);
  }
  if (p.stage === 'clips' && p.pct === 1) appendLog('ok', `clips: downloaded`);
  if (p.stage === 'tts' && p.pct === 1) appendLog('ok', `tts: voiceover ready`);
  if (p.stage === 'stitch' && p.pct === 1) appendLog('ok', `stitch: muxed`);
}

function appendLog(kind, msg) {
  const log = $('#progress-log');
  const line = document.createElement('div');
  line.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '';
  line.textContent = (kind === 'err' ? '× ' : kind === 'ok' ? '✓ ' : '· ') + msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ============== Upload ==============
async function uploadCurrent() {
  if (!state.currentProject) return;
  if (!state.ytStatus.connected) {
    return toast('Connect YouTube in Settings first.', 'err');
  }
  const params = {
    videoPath: state.currentProject.videoPath,
    thumbPath: state.currentProject.thumbPath,
    title: $('#result-title').value.slice(0, 100),
    description: $('#result-description').value.slice(0, 5000),
    tags: state.currentProject.script.tags || [],
    privacyStatus: $('#result-privacy').value,
  };
  $('#upload-btn').disabled = true;
  $('#upload-btn').textContent = 'Uploading…';
  $('#upload-progress').textContent = 'Starting…';
  const r = await api.ytUpload(params);
  $('#upload-btn').disabled = false;
  $('#upload-btn').textContent = 'Upload to YouTube';
  if (r.ok) {
    $('#upload-progress').innerHTML = `<a class="link" data-href="${r.url}">${r.url}</a>`;
    toast('Uploaded ✓', 'ok');
  } else {
    $('#upload-progress').textContent = 'Upload failed: ' + r.error;
    toast('Upload failed: ' + r.error, 'err');
  }
}

function handleUploadProgress(p) {
  if (!p) return;
  if (p.stage === 'upload:video') {
    const mb = (p.bytes / 1024 / 1024).toFixed(1);
    const total = (p.total / 1024 / 1024).toFixed(1);
    $('#upload-progress').textContent = `Uploading ${mb}MB / ${total}MB (${Math.round(p.pct * 100)}%)`;
  } else if (p.stage === 'upload:thumbnail') {
    $('#upload-progress').textContent = 'Setting thumbnail…';
  }
}

// ============== Library ==============
function bindLibrary() {}

async function refreshLibrary() {
  const list = await api.listProjects();
  const root = $('#library-list');
  root.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.innerHTML = 'No videos yet.<br><span class="muted small">Generate one in the Compose tab.</span>';
    root.appendChild(empty);
    return;
  }
  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'lib-item';
    const thumb = p.thumbPath ? 'file:///' + p.thumbPath.replace(/\\/g, '/') : '';
    card.innerHTML = `
      <div class="lib-thumb" style="background-image:url('${thumb}')"></div>
      <div class="lib-meta">
        <div class="lib-title">${escapeHtml(p.script?.title || p.prompt || 'Untitled')}</div>
        <div class="lib-sub">
          <span>${state.modes.find(m => m.id === p.modeId)?.name || p.modeId} • ${fmtDuration(p.durationSec)}</span>
          <span>${new Date(p.createdAt).toLocaleDateString()}</span>
        </div>
      </div>`;
    card.addEventListener('click', () => api.openProject(p.id));
    root.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============== Queue (Auto-Batch) ==============
function bindQueue() {
  $('#new-batch-btn').addEventListener('click', openBatchModal);
  $('#batch-cancel').addEventListener('click', () => $('#batch-modal').classList.add('hidden'));
  $('#batch-create').addEventListener('click', createBatch);
  // Update cost estimate when count/duration changes
  for (const sel of ['#batch-count', '#batch-duration', '#batch-interval']) {
    $(sel).addEventListener('change', updateBatchCostEstimate);
  }
}

function openBatchModal() {
  if (!state.license.active) {
    return toast('Auto-Batch is a Pro feature.', 'err');
  }
  // Populate mode dropdown
  const modeSel = $('#batch-mode');
  modeSel.innerHTML = '';
  for (const m of state.modes) {
    if (m.pro && !state.license.active) continue;
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modeSel.appendChild(opt);
  }
  $('#batch-seed').value = '';
  updateBatchCostEstimate();
  $('#batch-modal').classList.remove('hidden');
}

function updateBatchCostEstimate() {
  const count = parseInt($('#batch-count').value, 10) || 0;
  const dur = parseInt($('#batch-duration').value, 10) || 60;
  const interval = parseInt($('#batch-interval').value, 10) || 86400000;
  // Rough: ~50MB stock footage per minute of final video, plus ~10MB output per video.
  const gb = ((count * dur * 0.85 + count * 10) / 1024).toFixed(2);
  // Rough: ~30-90s of CPU per 60s of output (mostly FFmpeg encode).
  const cpuMin = Math.ceil(count * dur / 30);
  const cadence = interval === 3600000 ? 'hourly' : interval === 86400000 ? 'daily' : 'weekly';
  let warn = '';
  if (cadence === 'hourly' && count > 6) {
    warn = ` ⚠ Hourly with ${count} videos will hit YouTube's ~6/day quota fast — most will queue and retry.`;
  }
  $('#batch-cost').innerHTML = `This will generate <strong>${count}</strong> videos using ~<strong>${gb} GB</strong> of bandwidth and ~<strong>${cpuMin} min</strong> of CPU.${warn}`;
}

async function createBatch() {
  const seed = $('#batch-seed').value.trim();
  if (!seed) return toast('Add a seed topic.', 'err');
  const params = {
    seed,
    count: parseInt($('#batch-count').value, 10),
    intervalMs: parseInt($('#batch-interval').value, 10),
    modeId: $('#batch-mode').value,
    durationSec: parseInt($('#batch-duration').value, 10),
    voice: state.settings.voice,
    visibility: $('input[name="batchVis"]:checked')?.value || 'unlisted',
    burnSubtitles: state.settings.burnSubtitles,
  };
  $('#batch-create').disabled = true;
  $('#batch-create').textContent = 'Creating…';
  const r = await api.queueCreate(params);
  $('#batch-create').disabled = false;
  $('#batch-create').textContent = 'Create batch';
  if (!r.ok) return toast('Batch creation failed: ' + r.error, 'err');
  $('#batch-modal').classList.add('hidden');
  toast(`Batch created — ${params.count} videos queued.`, 'ok');
  refreshQueue();
}

async function refreshQueue() {
  const root = $('#queue-list');
  if (!state.license.active) {
    $('#queue-pro-gate').classList.remove('hidden');
    $('#new-batch-btn').classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  $('#queue-pro-gate').classList.add('hidden');
  $('#new-batch-btn').classList.remove('hidden');
  const batches = await api.queueList();
  root.innerHTML = '';
  if (!batches || batches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.innerHTML = 'No batches yet.<br><span class="muted small">Click + New batch to queue a series.</span>';
    root.appendChild(empty);
    return;
  }
  const cadenceLabel = (ms) => ms === 3600000 ? 'hourly' : ms === 86400000 ? 'daily' : ms === 604800000 ? 'weekly' : `${Math.round(ms / 60000)}m`;
  for (const b of batches) {
    const card = document.createElement('div');
    card.className = 'batch-card';
    const done = b.items.filter(i => i.status === 'done').length;
    const failed = b.items.filter(i => i.status === 'failed').length;
    const head = `
      <div class="batch-card-head">
        <div>
          <div class="batch-card-title">${escapeHtml(b.seed)}</div>
          <div class="batch-card-meta">${b.count} × ${state.modes.find(m => m.id === b.modeId)?.name || b.modeId} • ${fmtDuration(b.durationSec)} • ${cadenceLabel(b.intervalMs)} • ${done} done${failed ? ', ' + failed + ' failed' : ''}</div>
        </div>
        <div class="batch-card-actions">
          <button class="btn ghost small" data-act="delete" data-batch="${b.id}">Delete</button>
        </div>
      </div>
      <div class="batch-card-body">
        ${b.items.map(it => itemRow(b.id, it)).join('')}
      </div>`;
    card.innerHTML = head;
    root.appendChild(card);
  }
  // Wire actions
  root.querySelectorAll('[data-act="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const batchId = btn.dataset.batch;
      const ok = await confirmDialog('Delete batch?', 'This removes the queue and all pending items. Already-uploaded videos remain on YouTube.', 'Delete');
      if (!ok) return;
      await api.queueDelete(batchId);
      refreshQueue();
    });
  });
  root.querySelectorAll('[data-act="skip"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api.queueSkipItem(btn.dataset.batch, btn.dataset.item);
      refreshQueue();
    });
  });
}

function itemRow(batchId, it) {
  const due = it.dueAt ? new Date(it.dueAt) : null;
  const dueStr = due ? (due > new Date() ? `due ${due.toLocaleString()}` : `overdue (${due.toLocaleString()})`) : '—';
  const link = it.url ? `<a class="batch-item-link" data-href="${escapeHtml(it.url)}">${escapeHtml(it.url)}</a>` : '';
  const action = (it.status === 'pending')
    ? `<button class="btn ghost small" data-act="skip" data-batch="${batchId}" data-item="${it.id}">Skip</button>`
    : '';
  return `
    <div class="batch-item status-${it.status}">
      <div class="batch-item-status"></div>
      <div class="batch-item-prompt" title="${escapeHtml(it.prompt)}">${escapeHtml(it.prompt)}</div>
      <div class="batch-item-due">${it.status === 'done' ? link : (it.status === 'failed' ? escapeHtml(it.error || 'failed') : dueStr)}</div>
      <div>${action}</div>
    </div>`;
}

// ============== Slipstream ==============
function bindSlipstream() {
  $('#slipstream-add-btn').addEventListener('click', addSlipstream);
  $('#slipstream-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSlipstream(); });
}

async function addSlipstream() {
  if (!state.license.active) return toast('Slipstream is a Pro feature.', 'err');
  const v = $('#slipstream-input').value.trim();
  if (!v) return toast('Paste a channel URL or @handle.', 'err');
  $('#slipstream-add-btn').disabled = true;
  $('#slipstream-add-btn').textContent = 'Resolving…';
  const r = await api.slipstreamAdd(v);
  $('#slipstream-add-btn').disabled = false;
  $('#slipstream-add-btn').textContent = 'Follow';
  if (!r.ok) return toast('Could not add: ' + r.error, 'err');
  $('#slipstream-input').value = '';
  toast('Following ' + (r.source?.title || 'channel') + '.', 'ok');
  refreshSlipstream();
}

async function refreshSlipstream() {
  const root = $('#slipstream-list');
  if (!state.license.active) {
    $('#slipstream-pro-gate').classList.remove('hidden');
    $('#slipstream-controls').classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  $('#slipstream-pro-gate').classList.add('hidden');
  $('#slipstream-controls').classList.remove('hidden');
  const sources = await api.slipstreamList();
  root.innerHTML = '';
  if (!sources || sources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.innerHTML = 'No source channels yet.<br><span class="muted small">Paste a YouTube channel URL above to start.</span>';
    root.appendChild(empty);
    return;
  }
  for (const s of sources) {
    const item = document.createElement('div');
    item.className = 'slip-item' + (s.paused ? ' paused' : '');
    const last = s.lastPolledAt ? new Date(s.lastPolledAt).toLocaleString() : 'never';
    const avatar = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="%23EF4444" rx="24"/><text x="24" y="30" font-family="sans-serif" font-weight="700" font-size="18" fill="white" text-anchor="middle">${(s.title || '?').charAt(0).toUpperCase()}</text></svg>`)}`;
    item.innerHTML = `
      <img src="${avatar}" alt="">
      <div>
        <div class="slip-title">${escapeHtml(s.title)}</div>
        <div class="slip-sub">${s.processedCount || 0} videos generated • last polled ${last}${s.lastError ? ' • err: ' + escapeHtml(s.lastError) : ''}</div>
      </div>
      <button class="btn ghost small" data-act="${s.paused ? 'resume' : 'pause'}" data-cid="${s.channelId}">${s.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn ghost small" data-act="remove" data-cid="${s.channelId}">Remove</button>`;
    root.appendChild(item);
  }
  root.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.cid;
      const act = btn.dataset.act;
      if (act === 'pause') await api.slipstreamSetPaused(cid, true);
      else if (act === 'resume') await api.slipstreamSetPaused(cid, false);
      else if (act === 'remove') {
        const ok = await confirmDialog('Stop following this channel?', 'Spool will stop checking for new videos. Generated videos in your Library are unaffected.', 'Remove');
        if (!ok) return;
        await api.slipstreamRemove(cid);
      }
      refreshSlipstream();
    });
  });
}

// ============== Settings ==============
function bindSettings() {
  $('#settings-yt-connect').addEventListener('click', async () => {
    const r = await api.ytStartAuth();
    if (r.ok) { toast('Connected.', 'ok'); await refreshChannelPill(); refreshSettingsTab(); }
    else if (r.error === 'NO_GOOGLE_CREDS') toast('Add OAuth credentials first.', 'err');
    else toast('Auth failed: ' + r.error, 'err');
  });
  $('#settings-yt-disconnect').addEventListener('click', async () => {
    const ok = await confirmDialog('Disconnect YouTube?', 'Spool will stop uploading until you reconnect. Library, Queue, and Slipstream are preserved locally.', 'Disconnect');
    if (!ok) return;
    await api.ytLogout();
    state.ytStatus.connected = false;
    await refreshChannelPill();
    refreshSettingsTab();
    toast('Disconnected.', 'ok');
  });
  $('#settings-yt-switch').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Switch YouTube account?',
      'Spool will revoke the current login and open Google in your browser to pick a different account. Library, Queue, and Slipstream stay tied to this install.',
      'Switch account',
    );
    if (!ok) return;
    const r = await api.ytSwitchAccount();
    if (r.ok) {
      toast('Switched account.', 'ok');
      await refreshChannelPill();
      refreshSettingsTab();
    } else {
      toast('Switch failed: ' + r.error, 'err');
    }
  });
  $('#set-g-save').addEventListener('click', async () => {
    const id = $('#set-g-id').value.trim();
    const sec = $('#set-g-secret').value.trim();
    if (!id || !sec) return toast('Both required.', 'err');
    const r = await api.ytSetCreds(id, sec);
    if (!r.ok) return toast('Save failed.', 'err');
    state.ytStatus.hasCreds = true;
    toast('Saved.', 'ok');
  });
  $('#set-keys-save').addEventListener('click', async () => {
    const px = $('#set-pexels').value.trim();
    const pb = $('#set-pixabay').value.trim();
    if (px) await api.setSecret('pexelsKey', px);
    if (pb) await api.setSecret('pixabayKey', pb);
    toast('Keys saved.', 'ok');
    $('#set-pexels').value = ''; $('#set-pixabay').value = '';
  });
  $('#set-voice').addEventListener('change', async (e) => {
    await api.setSettings({ voice: e.target.value });
  });
  $('#set-channel-learning').addEventListener('change', async (e) => {
    await api.setSettings({ channelLearning: e.target.checked });
  });
  $$('input[name="autoVis"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const v = $('input[name="autoVis"]:checked')?.value || 'unlisted';
      state.settings.autoUploadVisibility = v;
      await api.setSettings({ autoUploadVisibility: v });
      refreshAutoUploadHint();
    });
  });
  $('#open-autoupload-log').addEventListener('click', () => api.autoUploadOpenLog());
  $('#license-activate').addEventListener('click', async () => {
    const k = $('#license-key').value.trim();
    const r = await api.activateLicense(k);
    if (r.ok) {
      toast('Pro activated.', 'ok');
      state.license = await api.getLicense();
      applyLicense();
      buildDurationPills();
      buildModeCards();
      await loadVoices();
      refreshSettingsTab();
      refreshQueue();
      refreshSlipstream();
    } else {
      toast(r.error, 'err');
    }
  });
  $('#check-updates').addEventListener('click', async () => {
    const r = await api.checkForUpdates();
    if (!r.ok) toast('Update check: ' + r.error, 'err');
  });
  $('#open-workspace').addEventListener('click', async () => {
    const info = await api.getAppInfo();
    api.showItemInFolder(info.workspaceDir);
  });

  // Pro dev backdoor — Ctrl+Shift+P inside Settings
  document.addEventListener('keydown', async (e) => {
    if ($('#tab-settings').classList.contains('active') && e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      await api.devUnlock();
      state.license = await api.getLicense();
      applyLicense();
      buildDurationPills();
      buildModeCards();
      await loadVoices();
      refreshSettingsTab();
      refreshQueue();
      refreshSlipstream();
      toast('Dev Pro unlocked.', 'ok');
    }
  });
}

async function refreshSettingsTab() {
  state.ytStatus = await api.ytStatus();
  const yt = $('#settings-yt-status');
  const card = $('#settings-channel-card');
  const switchBtn = $('#settings-yt-switch');
  const connectBtn = $('#settings-yt-connect');
  const discBtn = $('#settings-yt-disconnect');
  if (state.ytStatus.connected) {
    const ci = await api.ytChannelInfo();
    if (ci.ok && ci.channel) {
      card.classList.remove('hidden');
      $('#settings-channel-avatar').src = ci.channel.thumbnail || '';
      $('#settings-channel-title').textContent = ci.channel.title || '—';
      $('#settings-channel-sub').textContent = `${ci.channel.subscriberCount || '0'} subscribers · ${ci.channel.videoCount || '0'} videos`;
      yt.textContent = '';
    } else {
      card.classList.add('hidden');
      yt.textContent = 'Connected.';
    }
    connectBtn.classList.add('hidden');
    discBtn.classList.remove('hidden');
    switchBtn.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
    yt.textContent = 'Not connected.';
    connectBtn.classList.remove('hidden');
    discBtn.classList.add('hidden');
    switchBtn.classList.add('hidden');
  }
  state.license = await api.getLicense();
  $('#license-state').textContent = state.license.active
    ? `Pro active${state.license.source === 'dev' ? ' (dev)' : ''}.`
    : 'Free tier.';
  $('#set-channel-learning').checked = !!state.settings.channelLearning;

  const vis = state.settings.autoUploadVisibility || 'unlisted';
  const radio = document.querySelector(`input[name="autoVis"][value="${vis}"]`);
  if (radio) radio.checked = true;
  try {
    const s = await api.autoUploadStatus();
    const line = $('#autoupload-quota-line');
    if (line) {
      if (s.blocked) line.textContent = `Quota hit: ${s.count}/${s.limit} uploads used in last 24h.`;
      else line.textContent = `${s.count}/${s.limit} uploads used in last 24h.`;
    }
  } catch (_) {}
}

function applyLicense() {
  const pro = state.license.active;
  $('#pro-pill').classList.toggle('hidden', !pro);
}

async function refreshChannelPill() {
  if (!state.ytStatus.connected) {
    $('#channel-pill').classList.add('hidden');
    return;
  }
  const r = await api.ytChannelInfo();
  if (r.ok && r.channel) {
    $('#channel-pill').classList.remove('hidden');
    $('#channel-avatar').src = r.channel.thumbnail || '';
    $('#channel-name').textContent = r.channel.title || '';
    state.channelInfo = r.channel;
    if (state.settings.channelLearning && state.license.active) {
      api.ytChannelAnalysis().catch(() => {});
    }
  }
}

// ============== Updater ==============
function handleUpdaterStatus(s) {
  const line = $('#updater-line');
  if (!line || !s) return;
  if (s.state === 'checking') line.textContent = 'Checking for updates…';
  else if (s.state === 'available') line.textContent = `Update available: ${s.info?.version}`;
  else if (s.state === 'none') line.textContent = 'You are on the latest version.';
  else if (s.state === 'downloading') line.textContent = `Downloading… ${Math.round(s.percent || 0)}%`;
  else if (s.state === 'downloaded') line.textContent = `Update ready. Restart to apply.`;
  else if (s.state === 'error') line.textContent = `Update error: ${s.error || 'unknown'}`;
}

boot().catch(e => { console.error(e); toast('Boot error: ' + e.message, 'err'); });
