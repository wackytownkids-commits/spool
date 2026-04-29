const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Settings + secrets
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getSecret: (key) => ipcRenderer.invoke('secret:get', key),
  setSecret: (key, value) => ipcRenderer.invoke('secret:set', key, value),
  hasSecret: (key) => ipcRenderer.invoke('secret:has', key),

  // App info
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  listModes: () => ipcRenderer.invoke('modes:list'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  showItemInFolder: (p) => ipcRenderer.invoke('app:showItemInFolder', p),

  // YouTube OAuth
  ytStartAuth: () => ipcRenderer.invoke('yt:startAuth'),
  ytLogout: () => ipcRenderer.invoke('yt:logout'),
  ytStatus: () => ipcRenderer.invoke('yt:status'),
  ytSetCreds: (id, secret) => ipcRenderer.invoke('yt:setCreds', id, secret),
  ytGetCreds: () => ipcRenderer.invoke('yt:getCreds'),
  ytChannelInfo: () => ipcRenderer.invoke('yt:channelInfo'),
  ytChannelAnalysis: () => ipcRenderer.invoke('yt:channelAnalysis'),
  ytUpload: (params) => ipcRenderer.invoke('yt:upload', params),

  // Auto-upload
  autoUploadRun: (params) => ipcRenderer.invoke('autoUpload:run', params),
  autoUploadStatus: () => ipcRenderer.invoke('autoUpload:status'),
  autoUploadOpenLog: () => ipcRenderer.invoke('autoUpload:openLog'),

  // Auto-Batch queue
  queueList: () => ipcRenderer.invoke('queue:list'),
  queueCreate: (params) => ipcRenderer.invoke('queue:create', params),
  queueDelete: (batchId) => ipcRenderer.invoke('queue:delete', batchId),
  queueSkipItem: (batchId, itemId) => ipcRenderer.invoke('queue:skipItem', batchId, itemId),
  onQueueUpdate: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('queue:update', fn);
    return () => ipcRenderer.removeListener('queue:update', fn);
  },
  onQueueProgress: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('queue:progress', fn);
    return () => ipcRenderer.removeListener('queue:progress', fn);
  },

  // Slipstream
  slipstreamList: () => ipcRenderer.invoke('slipstream:list'),
  slipstreamAdd: (input) => ipcRenderer.invoke('slipstream:add', input),
  slipstreamRemove: (channelId) => ipcRenderer.invoke('slipstream:remove', channelId),
  slipstreamSetPaused: (channelId, paused) => ipcRenderer.invoke('slipstream:setPaused', channelId, paused),
  slipstreamResolve: (input) => ipcRenderer.invoke('slipstream:resolveChannel', input),
  onSlipstreamUpdate: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('slipstream:update', fn);
    return () => ipcRenderer.removeListener('slipstream:update', fn);
  },

  // Switch account
  ytSwitchAccount: () => ipcRenderer.invoke('yt:switchAccount'),

  // TTS
  ttsListVoices: () => ipcRenderer.invoke('tts:listVoices'),
  ttsPreview: (voice, text) => ipcRenderer.invoke('tts:preview', voice, text),

  // Generation
  generate: (params) => ipcRenderer.invoke('generate:start', params),
  cancelGenerate: () => ipcRenderer.invoke('generate:cancel'),

  // Library
  listProjects: () => ipcRenderer.invoke('library:list'),
  deleteProject: (id) => ipcRenderer.invoke('library:delete', id),
  openProject: (id) => ipcRenderer.invoke('library:open', id),

  // Pro / license
  getLicense: () => ipcRenderer.invoke('license:get'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  devUnlock: () => ipcRenderer.invoke('license:devUnlock'),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),

  // Events
  onProgress: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('generate:progress', fn);
    return () => ipcRenderer.removeListener('generate:progress', fn);
  },
  onUploadProgress: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('upload:progress', fn);
    return () => ipcRenderer.removeListener('upload:progress', fn);
  },
  onUpdateStatus: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('updater:status', fn);
    return () => ipcRenderer.removeListener('updater:status', fn);
  },
};

contextBridge.exposeInMainWorld('spool', api);
