// Headless capture: load renderer/index.html in an Electron window with a
// mocked window.spool bridge, drive UI state, save PNGs to .preview/.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const VIEWPORT = { width: 1440, height: 900 };
const OUT_DIR = path.join(__dirname, '..', '.preview');
fs.mkdirSync(OUT_DIR, { recursive: true });

const HTML = path.join(__dirname, '..', 'renderer', 'index.html');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _bust = 0;
async function load(win, state) {
  _bust++;
  const url = 'file://' + HTML.replace(/\\/g, '/') + '?n=' + _bust + '#' + encodeURIComponent(JSON.stringify(state || {}));
  await win.loadURL(url);
  // Inject animation kill-switch so screenshots aren't mid-frame
  await win.webContents.executeJavaScript(`
    (function(){
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;animation-fill-mode:forwards!important}';
      document.head.appendChild(s);
    })();
  `, true);
  await sleep(700); // let fonts settle + boot() finish
}

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
  console.log('captured', name);
}

async function js(win, code) {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (e) { console.error('JS ERROR:', e.message); return null; }
}

async function captureAll() {
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    show: false,
    backgroundColor: '#0a0a0d',
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 1. Setup wizard — step 1
  await load(win, { settings: { setupComplete: false } });
  await shoot(win, '01-setup-yt.png');

  // 2. Setup wizard — step 2 (advance via click)
  await load(win, { settings: { setupComplete: false } });
  await js(win, `document.getElementById('step-1-next').click();`);
  await sleep(250);
  await shoot(win, '02-setup-pexels.png');

  // 3. Setup wizard — step 3
  await load(win, { settings: { setupComplete: false } });
  await js(win, `document.getElementById('step-1-next').click();`);
  await sleep(120);
  await js(win, `document.getElementById('step-2-next').click();`);
  await sleep(250);
  await shoot(win, '03-setup-pixabay.png');

  // 4. Compose — empty (free, YT connected)
  await load(win, { yt: true });
  await shoot(win, '04-compose-empty.png');

  // 5. Compose — prompt typed + duration changed
  await load(win, { yt: true });
  await js(win, `
    const t = document.getElementById('prompt');
    t.value = 'top 5 most dangerous animals in the ocean';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('.duration-pill')).find(p => p.textContent === '30s')?.click();
  `);
  await sleep(150);
  await shoot(win, '05-compose-prompt.png');

  // 6. Compose — Pro user, all modes unlocked
  await load(win, { yt: true, pro: true });
  await js(win, `
    const t = document.getElementById('prompt');
    t.value = 'a slow documentary about deep ocean trenches';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mode="documentary"]').click();
    Array.from(document.querySelectorAll('.duration-pill')).find(p => p.textContent === '5m')?.click();
  `);
  await sleep(150);
  await shoot(win, '06-compose-pro.png');

  // 7. Library — empty
  await load(win, { yt: true });
  await js(win, `document.querySelector('[data-tab="library"]').click();`);
  await sleep(200);
  await shoot(win, '07-library-empty.png');

  // 8. Library — with mock projects
  await load(win, {
    yt: true,
    pro: true,
    projects: [
      { id: 'p1', createdAt: '2026-04-26T10:00:00Z', prompt: 'top 5 sharks',           modeId: 'topx',         durationSec: 60,  voice: 'en-US-AriaNeural', script: { title: 'Top 5 Most Terrifying Sharks Caught On Camera' },     videoPath: 'C:/x/p1/o.mp4', thumbPath: '', durationSeconds: 60  },
      { id: 'p2', createdAt: '2026-04-25T14:30:00Z', prompt: 'cinematic mountains',    modeId: 'documentary',  durationSec: 300, voice: 'en-US-GuyNeural',  script: { title: 'A Quiet Walk Through The Alps — Documentary' },        videoPath: 'C:/x/p2/o.mp4', thumbPath: '', durationSeconds: 300 },
      { id: 'p3', createdAt: '2026-04-24T09:15:00Z', prompt: 'hype basketball',        modeId: 'hype',         durationSec: 60,  voice: '',                 script: { title: 'BASKETBALL HYPE — 60 SECONDS OF FIRE' },               videoPath: 'C:/x/p3/o.mp4', thumbPath: '', durationSeconds: 60  },
      { id: 'p4', createdAt: '2026-04-23T20:00:00Z', prompt: 'how black holes work',   modeId: 'educational',  durationSec: 180, voice: 'en-US-EmmaNeural', script: { title: 'How Black Holes Actually Work (3-Minute Explainer)' }, videoPath: 'C:/x/p4/o.mp4', thumbPath: '', durationSeconds: 180 },
      { id: 'p5', createdAt: '2026-04-22T11:00:00Z', prompt: 'top 10 sci-fi reveals',  modeId: 'topx',         durationSec: 180, voice: 'en-GB-RyanNeural', script: { title: 'Top 10 Sci-Fi Plot Twists Of The Last Decade' },       videoPath: 'C:/x/p5/o.mp4', thumbPath: '', durationSeconds: 180 },
      { id: 'p6', createdAt: '2026-04-21T16:45:00Z', prompt: 'lofi study vibes',       modeId: 'compilation',  durationSec: 600, voice: '',                 script: { title: 'LoFi Study — 10 Minute Focus Pack' },                  videoPath: 'C:/x/p6/o.mp4', thumbPath: '', durationSeconds: 600 },
    ],
  });
  await js(win, `document.querySelector('[data-tab="library"]').click();`);
  await sleep(250);
  await shoot(win, '08-library-filled.png');

  // 9. Settings — Free
  await load(win, { yt: true });
  await js(win, `document.querySelector('[data-tab="settings"]').click();`);
  await sleep(250);
  await shoot(win, '09-settings-free.png');

  // 10. Settings — Pro
  await load(win, { yt: true, pro: true });
  await js(win, `document.querySelector('[data-tab="settings"]').click();`);
  await sleep(250);
  await shoot(win, '10-settings-pro.png');

  // 11. Compose — auto-upload toggle ON (scrolled so the toggle is visible)
  await load(win, { yt: true, settings: { autoUpload: true, autoUploadAcknowledged: true, autoUploadVisibility: 'unlisted' } });
  await js(win, `
    const t = document.getElementById('prompt');
    t.value = 'top 5 most dangerous animals in the ocean';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('.duration-pill')).find(p => p.textContent === '60s')?.click();
    // Scroll so the auto-upload block is visible (it sits between Duration and Voice)
    document.querySelector('.autoupload-row').scrollIntoView({ block: 'center' });
  `);
  await sleep(250);
  await shoot(win, '11-compose-autoupload-on.png');

  // 12. First-time auto-upload confirm modal
  await load(win, { yt: true });
  await js(win, `document.getElementById('opt-autoupload').click();`);
  await sleep(300);
  await shoot(win, '12-autoupload-confirm.png');

  // 13a. Queue — empty (Pro user, no batches yet)
  await load(win, { yt: true, pro: true });
  await js(win, `document.querySelector('[data-tab="queue"]').click();`);
  await sleep(250);
  await shoot(win, '14-queue-empty.png');

  // 13b. Queue — with mock batch
  const now = Date.now();
  const dayMs = 86400000;
  await load(win, {
    yt: true, pro: true,
    queue: [{
      id: 'b_demo',
      seed: 'cute cats compilation',
      count: 6,
      intervalMs: dayMs,
      modeId: 'topx',
      durationSec: 60,
      voice: 'en-US-AriaNeural',
      visibility: 'unlisted',
      burnSubtitles: true,
      createdAt: now - 3 * dayMs,
      items: [
        { id: 'i1', prompt: 'Cats afraid of cucumbers — top reactions', status: 'done',       dueAt: now - 3 * dayMs, createdAt: now, error: null, videoId: 'a', url: 'https://youtu.be/abc1', projectId: 'p1' },
        { id: 'i2', prompt: 'Cats discovering laser pointers compilation', status: 'done',       dueAt: now - 2 * dayMs, createdAt: now, error: null, videoId: 'b', url: 'https://youtu.be/abc2', projectId: 'p2' },
        { id: 'i3', prompt: 'Cats stuck in boxes — funny moments',          status: 'done',       dueAt: now - 1 * dayMs, createdAt: now, error: null, videoId: 'c', url: 'https://youtu.be/abc3', projectId: 'p3' },
        { id: 'i4', prompt: 'Cats vs roombas — wild rides',                 status: 'generating', dueAt: now,             createdAt: now, error: null, videoId: null, url: null, projectId: null },
        { id: 'i5', prompt: 'Cats reacting to mirrors for the first time', status: 'pending',    dueAt: now + 1 * dayMs, createdAt: now, error: null, videoId: null, url: null, projectId: null },
        { id: 'i6', prompt: 'Cats playing piano badly compilation',         status: 'pending',    dueAt: now + 2 * dayMs, createdAt: now, error: null, videoId: null, url: null, projectId: null },
      ],
    }],
  });
  await js(win, `document.querySelector('[data-tab="queue"]').click();`);
  await sleep(250);
  await shoot(win, '15-queue-active.png');

  // 13c. Queue — new batch modal (Pro user)
  await load(win, { yt: true, pro: true });
  await js(win, `document.querySelector('[data-tab="queue"]').click();`);
  await sleep(150);
  await js(win, `document.getElementById('new-batch-btn').click();`);
  await sleep(200);
  await js(win, `document.getElementById('batch-seed').value = 'top sci-fi plot twists'; document.getElementById('batch-seed').dispatchEvent(new Event('input',{bubbles:true}));`);
  await sleep(150);
  await shoot(win, '16-batch-modal.png');

  // 13d. Slipstream — Pro user with mock sources + ethics card visible
  const slipNow = Date.now();
  await load(win, {
    yt: true, pro: true,
    slipstream: [
      { channelId: 'UC1', title: 'MKBHD',          paused: false, addedAt: slipNow - 8 * dayMs,  lastPolledAt: slipNow - 5 * 60 * 1000, lastSeenVideoId: 'v1', lastError: null, processedCount: 12 },
      { channelId: 'UC2', title: 'Veritasium',     paused: false, addedAt: slipNow - 14 * dayMs, lastPolledAt: slipNow - 12 * 60 * 1000, lastSeenVideoId: 'v2', lastError: null, processedCount: 5  },
      { channelId: 'UC3', title: 'Linus Tech Tips', paused: true, addedAt: slipNow - 30 * dayMs, lastPolledAt: slipNow - 60 * 60 * 1000, lastSeenVideoId: 'v3', lastError: null, processedCount: 22 },
    ],
  });
  await js(win, `document.querySelector('[data-tab="slipstream"]').click();`);
  await sleep(250);
  await shoot(win, '17-slipstream.png');

  // 14. Settings — auto-upload section visible (scrolled)
  await load(win, { yt: true, settings: { autoUploadVisibility: 'unlisted' } });
  await js(win, `document.querySelector('[data-tab="settings"]').click();`);
  await sleep(250);
  await js(win, `
    const blocks = document.querySelectorAll('.settings-block h3');
    const target = Array.from(blocks).find(h => h.textContent === 'Auto-upload');
    if (target) target.closest('.settings-block').scrollIntoView({ block: 'center', behavior: 'instant' });
  `);
  await sleep(300);
  await shoot(win, '13-settings-autoupload.png');

  console.log('all done');
  app.quit();
}

app.whenReady().then(() => {
  captureAll().catch((e) => { console.error('CAPTURE FAIL', e); app.exit(1); });
});
