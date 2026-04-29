const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const log = require('electron-log');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const { startAuth, getAuthClient, logout } = require('./src/auth');
const youtube = require('./src/youtube');
const tts = require('./src/tts');
const pipeline = require('./src/pipeline');
const library = require('./src/library');
const queue = require('./src/queue');
const slipstream = require('./src/slipstream');
const { ALL_MODES, getMode, isProMode } = require('./src/modes');

log.transports.file.level = 'info';
log.info('Spool starting');

const store = new Store({ name: 'spool', clearInvalidConfig: true });
const secretStore = new Store({ name: 'spool-secrets', clearInvalidConfig: true });

// Workspace root
const workspaceDir = path.join(app.getPath('userData'), 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0a0a0d',
    title: 'Spool',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  setTimeout(() => { try { autoUpdater.checkForUpdatesAndNotify(); } catch (_) {} }, 4000);
  initQueueAndSlipstream();
});

function initQueueAndSlipstream() {
  // Queue: Pro-only feature, but the scheduler runs always so paused queues
  // resume cleanly when the user activates Pro / re-opens the app.
  queue.init({
    file: path.join(workspaceDir, 'queue.json'),
    onChange: (q) => mainWindow?.webContents.send('queue:update', q),
    processItem: async (item) => processQueueItem(item),
  });
  slipstream.init({
    file: path.join(workspaceDir, 'slipstream.json'),
    onChange: (sources) => mainWindow?.webContents.send('slipstream:update', sources),
    processSource: async (entry) => processSlipstreamItem(entry),
  });
}

// Queue processor: runs the full pipeline + auto-uploads with the batch's
// configured visibility. Returns { ok, videoId, url, projectId, uploadOk, uploadError }.
async function processQueueItem(item) {
  const settings = getSettings();
  const pexelsKey = decrypt(secretStore.get('pexelsKey'));
  const pixabayKey = decrypt(secretStore.get('pixabayKey'));
  if (!pexelsKey && !pixabayKey) return { ok: false, error: 'NO_KEYS' };

  let project;
  try {
    project = await pipeline.generate({
      prompt: item.prompt,
      modeId: item.modeId,
      durationSec: item.durationSec,
      voice: item.voice || settings.voice,
      burnSubtitles: item.burnSubtitles ?? settings.burnSubtitles,
      channelHint: '',
      pexelsKey,
      pixabayKey,
      workspaceDir,
      onProgress: (p) => mainWindow?.webContents.send('queue:progress', { itemId: item.id, ...p }),
    });
  } catch (e) {
    log.error('queue: generate failed', e);
    return { ok: false, error: e.code || e.message };
  }

  // Auto-upload if connected; otherwise mark generated-but-not-uploaded
  const auth = getAuthClient(store);
  if (!auth) {
    appendAuditLog({ source: 'queue', title: project.script?.title, ok: false, error: 'NOT_CONNECTED' });
    return { ok: true, projectId: project.id, uploadOk: false, uploadError: 'YouTube not connected' };
  }
  const before = uploadsInLast24h();
  if (before >= QUOTA_LIMIT_24H) {
    appendAuditLog({ source: 'queue', title: project.script?.title, ok: false, error: 'QUOTA_BLOCKED', count: before });
    return { ok: true, projectId: project.id, uploadOk: false, uploadError: 'Daily YouTube quota hit' };
  }
  try {
    const r = await youtube.uploadVideo(auth, {
      videoPath: project.videoPath,
      thumbPath: project.thumbPath,
      title: (project.script?.title || item.prompt).slice(0, 100),
      description: (project.script?.description || '').slice(0, 5000),
      tags: project.script?.tags || [],
      privacyStatus: item.visibility || 'unlisted',
    });
    recordUpload({ success: true, videoId: r.videoId, source: 'queue' });
    appendAuditLog({ source: 'queue', title: project.script?.title, ok: true, videoId: r.videoId, url: r.url });
    return { ok: true, projectId: project.id, uploadOk: true, videoId: r.videoId, url: r.url };
  } catch (e) {
    appendAuditLog({ source: 'queue', title: project.script?.title, ok: false, error: e.message });
    return { ok: true, projectId: project.id, uploadOk: false, uploadError: e.message };
  }
}

async function processSlipstreamItem(entry) {
  // Reuse queue's processor by faking an item — keeps quota tracking + audit
  // log consistent. We pull config from settings (default mode/duration/voice).
  const settings = getSettings();
  return processQueueItem({
    id: 'slipstream_' + entry.sourceVideoId,
    prompt: entry.prompt,
    modeId: settings.defaultMode || 'topx',
    durationSec: settings.defaultDuration || 60,
    voice: settings.voice,
    burnSubtitles: settings.burnSubtitles,
    visibility: settings.autoUploadVisibility || 'unlisted',
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===== Encrypted secrets =====

function encrypt(plain) {
  if (!plain) return '';
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(plain, 'utf8').toString('base64');
  return safeStorage.encryptString(plain).toString('base64');
}
function decrypt(b64) {
  if (!b64) return '';
  try {
    if (!safeStorage.isEncryptionAvailable()) return Buffer.from(b64, 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch (e) { return ''; }
}

ipcMain.handle('secret:set', (_, key, value) => {
  secretStore.set(key, encrypt(value || ''));
  return true;
});
ipcMain.handle('secret:get', (_, key) => decrypt(secretStore.get(key)));
ipcMain.handle('secret:has', (_, key) => Boolean(secretStore.get(key)));

// ===== Settings =====

const DEFAULT_SETTINGS = {
  voice: 'en-US-AriaNeural',
  defaultMode: 'topx',
  defaultDuration: 60,
  burnSubtitles: true,
  channelLearning: true,
  setupComplete: false,
  autoUpload: false,
  autoUploadAcknowledged: false,
  autoUploadVisibility: 'unlisted',
};

// ===== Auto-upload quota + audit log =====

const QUOTA_LIMIT_24H = 6;
const QUOTA_WARN_AT = 5;

function getUploadHistory() {
  return store.get('uploadHistory') || [];
}
function recordUpload(meta) {
  const hist = getUploadHistory();
  hist.push({ ts: Date.now(), ...meta });
  while (hist.length > 100) hist.shift();
  store.set('uploadHistory', hist);
}
function uploadsInLast24h(history) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return (history || getUploadHistory()).filter(h => h.success && h.ts >= cutoff).length;
}

const auditLogPath = path.join(app.getPath('userData'), 'logs', 'auto-upload.log');
fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
function appendAuditLog(entry) {
  try {
    fs.appendFileSync(auditLogPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    log.warn('audit log write failed:', e.message);
  }
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}) };
}

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_, patch) => {
  const next = { ...getSettings(), ...patch };
  store.set('settings', next);
  return next;
});

// ===== App info =====

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  workspaceDir,
  platform: process.platform,
  isPackaged: app.isPackaged,
}));
ipcMain.handle('app:openExternal', (_, url) => shell.openExternal(url));
ipcMain.handle('app:showItemInFolder', (_, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ===== License / Pro =====

const PRO_KEY_PREFIX = 'SPOOL-PRO-';
ipcMain.handle('license:get', () => ({
  active: !!store.get('license.active'),
  key: store.get('license.key') || '',
  source: store.get('license.source') || '',
}));
ipcMain.handle('license:activate', (_, key) => {
  if (typeof key !== 'string' || !key.startsWith(PRO_KEY_PREFIX) || key.length < 16) {
    return { ok: false, error: 'Invalid key format.' };
  }
  // TODO: validate against Gumroad license API once product is set up.
  store.set('license.active', true);
  store.set('license.key', key);
  store.set('license.source', 'manual');
  return { ok: true };
});
ipcMain.handle('license:devUnlock', () => {
  store.set('license.active', true);
  store.set('license.key', 'DEV-BACKDOOR');
  store.set('license.source', 'dev');
  return { ok: true };
});

// ===== YouTube =====

ipcMain.handle('yt:status', () => {
  const tokens = store.get('ytTokens');
  // hasCreds reflects "OAuth is functional" — true if either user-overridden
  // creds exist OR Spool's baked-in defaults are populated. The auth module
  // falls back to defaults when overrides are absent, so we mirror that here.
  const overrideId = store.get('googleClientId');
  const overrideSecret = store.get('googleClientSecret');
  const hasOverride = !!overrideId && !!overrideSecret;
  const { hasDefaultCreds } = require('./src/auth');
  return {
    connected: !!tokens?.refresh_token,
    hasCreds: hasOverride || hasDefaultCreds(),
    hasOverride,
  };
});

ipcMain.handle('yt:setCreds', (_, id, secret) => {
  if (!id || !secret) return { ok: false, error: 'missing' };
  store.set('googleClientId', id);
  store.set('googleClientSecret', secret);
  return { ok: true };
});

ipcMain.handle('yt:getCreds', () => ({
  clientId: store.get('googleClientId') || '',
  // Don't expose the secret back to the renderer; just whether one is set.
  hasSecret: !!store.get('googleClientSecret'),
}));

ipcMain.handle('yt:startAuth', async () => {
  try {
    await startAuth(store);
    return { ok: true };
  } catch (e) {
    log.error('yt:startAuth', e);
    return { ok: false, error: e.code || e.message };
  }
});

ipcMain.handle('yt:logout', () => { logout(store); return { ok: true }; });

ipcMain.handle('yt:channelInfo', async () => {
  const auth = getAuthClient(store);
  if (!auth) return { ok: false, error: 'NOT_CONNECTED' };
  try {
    const ch = await youtube.getChannel(auth);
    return {
      ok: true,
      channel: ch ? {
        id: ch.id,
        title: ch.snippet?.title,
        thumbnail: ch.snippet?.thumbnails?.default?.url,
        subscriberCount: ch.statistics?.subscriberCount,
        videoCount: ch.statistics?.videoCount,
      } : null,
    };
  } catch (e) {
    log.error('channelInfo', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:channelAnalysis', async () => {
  const auth = getAuthClient(store);
  if (!auth) return { ok: false, error: 'NOT_CONNECTED' };
  try {
    const cached = store.get('channelAnalysis');
    const cachedAt = store.get('channelAnalysisAt') || 0;
    const stale = Date.now() - cachedAt > 24 * 3600 * 1000;
    if (cached && !stale) return { ok: true, analysis: cached, cached: true };

    const videos = await youtube.getRecentVideos(auth, 50);
    const analysis = youtube.analyzeChannelVideos(videos);
    if (analysis) {
      store.set('channelAnalysis', analysis);
      store.set('channelAnalysisAt', Date.now());
    }
    return { ok: true, analysis };
  } catch (e) {
    log.error('channelAnalysis', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:upload', async (_, params) => {
  const auth = getAuthClient(store);
  if (!auth) return { ok: false, error: 'NOT_CONNECTED' };
  try {
    const r = await youtube.uploadVideo(auth, {
      ...params,
      onProgress: (p) => mainWindow?.webContents.send('upload:progress', p),
    });
    // Manual uploads also count against the daily quota tracker.
    recordUpload({ success: true, videoId: r.videoId, source: 'manual' });
    return { ok: true, ...r };
  } catch (e) {
    log.error('upload', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('autoUpload:status', () => {
  const count = uploadsInLast24h();
  return {
    count,
    limit: QUOTA_LIMIT_24H,
    warnAt: QUOTA_WARN_AT,
    warn: count >= QUOTA_WARN_AT,
    blocked: count >= QUOTA_LIMIT_24H,
  };
});

ipcMain.handle('autoUpload:run', async (_, params) => {
  const auth = getAuthClient(store);
  if (!auth) {
    appendAuditLog({ title: params?.title, ok: false, error: 'NOT_CONNECTED' });
    return { ok: false, error: 'NOT_CONNECTED' };
  }
  const before = uploadsInLast24h();
  if (before >= QUOTA_LIMIT_24H) {
    appendAuditLog({ title: params?.title, ok: false, error: 'QUOTA_BLOCKED', count: before });
    return { ok: false, error: 'QUOTA_BLOCKED', count: before, limit: QUOTA_LIMIT_24H };
  }
  try {
    const r = await youtube.uploadVideo(auth, {
      ...params,
      onProgress: (p) => mainWindow?.webContents.send('upload:progress', p),
    });
    recordUpload({ success: true, videoId: r.videoId, source: 'auto' });
    appendAuditLog({ title: params?.title, ok: true, videoId: r.videoId, url: r.url, visibility: params?.privacyStatus });
    const after = before + 1;
    return { ok: true, ...r, count: after, limit: QUOTA_LIMIT_24H, warn: after >= QUOTA_WARN_AT };
  } catch (e) {
    log.error('autoUpload', e);
    appendAuditLog({ title: params?.title, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('autoUpload:openLog', () => {
  if (fs.existsSync(auditLogPath)) shell.showItemInFolder(auditLogPath);
});

// ===== TTS =====

let _voiceCache;
ipcMain.handle('tts:listVoices', async () => {
  if (_voiceCache) return _voiceCache;
  try {
    _voiceCache = await tts.listVoices();
    return _voiceCache;
  } catch (e) {
    log.warn('listVoices', e.message);
    return tts.FREE_VOICES.map(n => ({ shortName: n, displayName: n, locale: n, gender: '' }));
  }
});

ipcMain.handle('tts:preview', async (_, voice, text) => {
  try {
    const out = path.join(app.getPath('temp'), `spool_preview_${Date.now()}`);
    const f = await tts.speakToFile({
      text: (text || 'This is a quick preview from Spool.').slice(0, 200),
      voice: voice || 'en-US-AriaNeural',
      outFile: out + '.mp3',
    });
    return { ok: true, file: f };
  } catch (e) {
    log.error('tts:preview', e);
    return { ok: false, error: e.message };
  }
});

// ===== Generation =====

ipcMain.handle('generate:start', async (_, params) => {
  if (pipeline.isActive()) return { ok: false, error: 'ALREADY_RUNNING' };
  const settings = getSettings();
  const license = !!store.get('license.active');

  // Pro gating
  if (isProMode(params.modeId) && !license) {
    return { ok: false, error: 'PRO_REQUIRED', detail: `${getMode(params.modeId).name} is a Pro mode.` };
  }
  if (!license && params.durationSec > 60) {
    return { ok: false, error: 'PRO_REQUIRED', detail: 'Free tier is capped at 60-second videos.' };
  }

  const pexelsKey = decrypt(secretStore.get('pexelsKey'));
  const pixabayKey = decrypt(secretStore.get('pixabayKey'));
  if (!pexelsKey && !pixabayKey) {
    return { ok: false, error: 'NO_KEYS', detail: 'Add a Pexels or Pixabay API key in Settings.' };
  }

  // Channel learning hint
  let channelHint = '';
  if (license && settings.channelLearning) {
    const a = store.get('channelAnalysis');
    if (a) channelHint = youtube.analysisToHint(a);
  }

  try {
    const project = await pipeline.generate({
      prompt: params.prompt,
      modeId: params.modeId,
      durationSec: params.durationSec,
      voice: params.voice || settings.voice,
      burnSubtitles: params.burnSubtitles ?? settings.burnSubtitles,
      channelHint,
      pexelsKey,
      pixabayKey,
      workspaceDir,
      onProgress: (p) => mainWindow?.webContents.send('generate:progress', p),
    });
    return { ok: true, project };
  } catch (e) {
    log.error('generate', e);
    return { ok: false, error: e.code || e.message };
  }
});

ipcMain.handle('generate:cancel', () => {
  pipeline.requestCancel();
  return { ok: true };
});

// ===== Library =====

ipcMain.handle('library:list', () => library.listProjects(workspaceDir));
ipcMain.handle('library:delete', (_, id) => library.deleteProject(workspaceDir, id));
ipcMain.handle('library:open', (_, id) => {
  const p = library.getProject(workspaceDir, id);
  if (p?.videoPath) shell.showItemInFolder(p.videoPath);
  return p;
});

// ===== Auto-updater =====

autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('updater:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('updater:status', { state: 'available', info }));
autoUpdater.on('update-not-available', () => mainWindow?.webContents.send('updater:status', { state: 'none' }));
autoUpdater.on('error', (err) => mainWindow?.webContents.send('updater:status', { state: 'error', error: err?.message }));
autoUpdater.on('download-progress', (p) => mainWindow?.webContents.send('updater:status', { state: 'downloading', percent: p.percent }));
autoUpdater.on('update-downloaded', (info) => mainWindow?.webContents.send('updater:status', { state: 'downloaded', info }));

ipcMain.handle('updater:check', async () => {
  try { const r = await autoUpdater.checkForUpdates(); return { ok: true, info: r?.updateInfo }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Expose modes list (read by renderer at boot via preload bootstrap)
ipcMain.handle('modes:list', () => ALL_MODES.map(m => ({
  id: m.id,
  name: m.name,
  tagline: m.tagline,
  pro: m.pro,
  defaultDuration: m.defaultDuration,
  hasNarration: m.voice !== null,
})));

// ===== Queue (Auto-Batch) =====

ipcMain.handle('queue:list', () => queue.getQueue());

ipcMain.handle('queue:create', async (_, params) => {
  if (!store.get('license.active')) return { ok: false, error: 'PRO_REQUIRED' };
  if (!params || !params.seed || !params.count || !params.intervalMs) {
    return { ok: false, error: 'INVALID_PARAMS' };
  }
  if (params.count > 30) return { ok: false, error: 'COUNT_TOO_HIGH' };
  try {
    const id = await queue.createBatch({
      seed: params.seed,
      count: params.count,
      intervalMs: params.intervalMs,
      modeId: params.modeId || 'topx',
      durationSec: params.durationSec || 60,
      voice: params.voice,
      visibility: params.visibility || 'unlisted',
      burnSubtitles: params.burnSubtitles ?? true,
    });
    return { ok: true, batchId: id };
  } catch (e) {
    log.error('queue:create', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('queue:delete', (_, batchId) => { queue.deleteBatch(batchId); return { ok: true }; });
ipcMain.handle('queue:skipItem', (_, batchId, itemId) => { queue.skipItem(batchId, itemId); return { ok: true }; });

// ===== Slipstream =====

ipcMain.handle('slipstream:list', () => slipstream.getSources());

ipcMain.handle('slipstream:add', async (_, input) => {
  if (!store.get('license.active')) return { ok: false, error: 'PRO_REQUIRED' };
  return await slipstream.addSource(input);
});

ipcMain.handle('slipstream:remove', (_, channelId) => { slipstream.removeSource(channelId); return { ok: true }; });
ipcMain.handle('slipstream:setPaused', (_, channelId, paused) => { slipstream.setPaused(channelId, paused); return { ok: true }; });

ipcMain.handle('slipstream:resolveChannel', async (_, input) => {
  return await slipstream.resolveChannel(input);
});

// ===== Switch / disconnect YouTube account =====

ipcMain.handle('yt:switchAccount', async () => {
  // Revoke + clear local tokens, then restart auth flow.
  const tokens = store.get('ytTokens');
  if (tokens?.access_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.access_token}`, { method: 'POST' });
    } catch (_) {}
  }
  logout(store);
  store.delete('channelAnalysis');
  store.delete('channelAnalysisAt');
  // Library + queue + slipstream stay tied to the local install — preserved.
  try {
    await startAuth(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
});
