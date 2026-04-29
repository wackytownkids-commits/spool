// Injected before renderer.js. Reads state from location.hash so it survives
// page navigation. Installs window.spool with mock implementations.

(function () {
  let state = {};
  try {
    const h = (location.hash || '').replace(/^#/, '');
    if (h) state = JSON.parse(decodeURIComponent(h));
  } catch (_) {}

  const settings = Object.assign(
    { setupComplete: true, voice: 'en-US-AriaNeural', defaultMode: 'topx', defaultDuration: 60, burnSubtitles: true, channelLearning: true },
    state.settings || {}
  );

  window.spool = {
    listModes: () => Promise.resolve([
      { id: 'topx',         name: 'Top X List',     tagline: 'Countdown energy. Fast cuts.',         pro: false, defaultDuration: 60,  hasNarration: true  },
      { id: 'storyteller',  name: 'Storyteller',    tagline: 'Narrative arc. Cinematic feel.',       pro: false, defaultDuration: 180, hasNarration: true  },
      { id: 'educational',  name: 'Educational',    tagline: 'Explainer with overlays.',             pro: false, defaultDuration: 180, hasNarration: true  },
      { id: 'hype',         name: 'Hype Montage',   tagline: 'Music only. Beat-cut. Big titles.',    pro: true,  defaultDuration: 60,  hasNarration: false },
      { id: 'documentary',  name: 'Documentary',    tagline: 'Slow. Contemplative.',                 pro: true,  defaultDuration: 300, hasNarration: true  },
      { id: 'news',         name: 'News Recap',     tagline: 'Headline graphics. Anchor cadence.',   pro: true,  defaultDuration: 120, hasNarration: true  },
      { id: 'compilation',  name: 'Compilation',    tagline: 'Themed clips. Music only.',            pro: false, defaultDuration: 90,  hasNarration: false },
    ]),
    getSettings: () => Promise.resolve({ ...settings }),
    setSettings: (p) => Promise.resolve(Object.assign(settings, p)),
    getSecret: () => Promise.resolve(''),
    setSecret: () => Promise.resolve(true),
    hasSecret: () => Promise.resolve(true),
    getAppInfo: () => Promise.resolve({ version: '1.0.0', workspaceDir: 'C:/Spool', platform: 'win32', isPackaged: false }),
    openExternal: () => Promise.resolve(),
    showItemInFolder: () => Promise.resolve(),
    ytStartAuth: () => Promise.resolve({ ok: true }),
    ytLogout: () => Promise.resolve({ ok: true }),
    ytStatus: () => Promise.resolve({ connected: !!state.yt, hasCreds: true }),
    ytSetCreds: () => Promise.resolve({ ok: true }),
    ytGetCreds: () => Promise.resolve({ clientId: '', hasSecret: false }),
    ytChannelInfo: () => Promise.resolve(state.yt ? {
      ok: true,
      channel: {
        id: 'UC123',
        title: 'Wackytown Kids',
        thumbnail: 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22><rect width=%2224%22 height=%2224%22 fill=%22%23EF4444%22 rx=%2212%22/><text x=%2212%22 y=%2216%22 font-family=%22sans-serif%22 font-weight=%22700%22 font-size=%2210%22 fill=%22white%22 text-anchor=%22middle%22>WK</text></svg>',
        subscriberCount: '12100',
        videoCount: '47',
      },
    } : { ok: false, error: 'NOT_CONNECTED' }),
    ytChannelAnalysis: () => Promise.resolve({ ok: true, analysis: null }),
    ytUpload: () => Promise.resolve({ ok: true, videoId: 'abc', url: 'https://youtu.be/abc' }),
    autoUploadRun: () => Promise.resolve({ ok: true, videoId: 'abc', url: 'https://youtu.be/abc', count: 1, limit: 6, warn: false }),
    autoUploadStatus: () => Promise.resolve({ count: state.uploadsToday || 0, limit: 6, warnAt: 5, warn: (state.uploadsToday || 0) >= 5, blocked: (state.uploadsToday || 0) >= 6 }),
    autoUploadOpenLog: () => Promise.resolve(),

    // Auto-Batch
    queueList: () => Promise.resolve(state.queue || []),
    queueCreate: () => Promise.resolve({ ok: true, batchId: 'b_demo' }),
    queueDelete: () => Promise.resolve({ ok: true }),
    queueSkipItem: () => Promise.resolve({ ok: true }),
    onQueueUpdate: () => () => {},
    onQueueProgress: () => () => {},

    // Slipstream
    slipstreamList: () => Promise.resolve(state.slipstream || []),
    slipstreamAdd: () => Promise.resolve({ ok: true, source: { channelId: 'UC_demo', title: 'Demo Channel' } }),
    slipstreamRemove: () => Promise.resolve({ ok: true }),
    slipstreamSetPaused: () => Promise.resolve({ ok: true }),
    slipstreamResolve: () => Promise.resolve({ channelId: 'UC_demo', title: 'Demo Channel' }),
    onSlipstreamUpdate: () => () => {},

    ytSwitchAccount: () => Promise.resolve({ ok: true }),
    ttsListVoices: () => Promise.resolve([
      { shortName: 'en-US-AriaNeural',    displayName: 'Aria',    locale: 'en-US', gender: 'Female' },
      { shortName: 'en-US-GuyNeural',     displayName: 'Guy',     locale: 'en-US', gender: 'Male'   },
      { shortName: 'en-US-JennyNeural',   displayName: 'Jenny',   locale: 'en-US', gender: 'Female' },
      { shortName: 'en-US-DavisNeural',   displayName: 'Davis',   locale: 'en-US', gender: 'Male'   },
      { shortName: 'en-US-EmmaNeural',    displayName: 'Emma',    locale: 'en-US', gender: 'Female' },
      { shortName: 'en-US-AndrewNeural',  displayName: 'Andrew',  locale: 'en-US', gender: 'Male'   },
      { shortName: 'en-GB-SoniaNeural',   displayName: 'Sonia',   locale: 'en-GB', gender: 'Female' },
      { shortName: 'en-GB-RyanNeural',    displayName: 'Ryan',    locale: 'en-GB', gender: 'Male'   },
      { shortName: 'en-AU-NatashaNeural', displayName: 'Natasha', locale: 'en-AU', gender: 'Female' },
      { shortName: 'en-AU-WilliamNeural', displayName: 'William', locale: 'en-AU', gender: 'Male'   },
    ]),
    ttsPreview: () => Promise.resolve({ ok: false }),
    generate: () => new Promise(() => {}),
    cancelGenerate: () => Promise.resolve({ ok: true }),
    listProjects: () => Promise.resolve(state.projects || []),
    deleteProject: () => Promise.resolve(true),
    openProject: () => Promise.resolve(null),
    getLicense: () => Promise.resolve(state.pro
      ? { active: true,  key: 'SPOOL-PRO-DEMO-2026', source: 'manual' }
      : { active: false, key: '', source: '' }),
    activateLicense: () => Promise.resolve({ ok: true }),
    devUnlock: () => Promise.resolve({ ok: true }),
    checkForUpdates: () => Promise.resolve({ ok: true }),
    onProgress: () => () => {},
    onUploadProgress: () => () => {},
    onUpdateStatus: () => () => {},
  };
})();
