// Pipeline orchestrator — runs the full generation flow stage by stage
// and emits granular progress events. One active job at a time.

const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { writeScript } = require('./script-writer');
const { fetchClipForScene } = require('./clip-fetcher');
const { speakToFile } = require('./tts');
const { fetchMusicForVibe } = require('./music');
const { stitch } = require('./stitcher');
const { getMode } = require('./modes');

let _active = false;
let _cancelRequested = false;

function isActive() { return _active; }
function requestCancel() { _cancelRequested = true; }
function checkCancel() {
  if (_cancelRequested) {
    const e = new Error('CANCELED');
    e.code = 'CANCELED';
    throw e;
  }
}

async function generate({
  prompt,
  modeId,
  durationSec,
  voice,
  burnSubtitles,
  channelHint,
  pexelsKey,
  pixabayKey,
  workspaceDir,        // %APPDATA%/Spool
  isShorts,            // bool — vertical 9:16, max 60s
  onProgress,
}) {
  if (_active) throw new Error('A generation is already running.');
  _active = true;
  _cancelRequested = false;

  const mode = getMode(modeId);
  // Mode can force shorts (e.g. 'Shorts Hook'); otherwise honor the flag.
  const wantsShorts = !!(isShorts || mode.forceShorts);
  // Shorts: 1080x1920 vertical, capped at 60s. Long-form: 1920x1080.
  const targetWidth = wantsShorts ? 1080 : 1920;
  const targetHeight = wantsShorts ? 1920 : 1080;
  const effectiveDuration = wantsShorts ? Math.min(durationSec, 60) : durationSec;
  const projectId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const projectDir = path.join(workspaceDir, 'projects', projectId);
  const cacheDir = path.join(workspaceDir, 'cache');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const update = (stage, pct, extra) => {
    onProgress?.({ stage, pct: Math.max(0, Math.min(1, pct)), ...extra });
  };

  try {
    // 1. Script
    update('script', 0, { message: 'Writing script...' });
    const script = await writeScript({ prompt, modeId, durationSec: effectiveDuration, channelHint, isShorts: wantsShorts });
    checkCancel();
    update('script', 1, { script });

    // 2. Clips (parallel, capped concurrency)
    update('clips', 0, { message: 'Fetching stock footage...' });
    const clipFiles = new Array(script.scenes.length).fill(null);
    const concurrency = 3;
    let nextIdx = 0;
    const workers = new Array(concurrency).fill(0).map(async () => {
      while (true) {
        checkCancel();
        const i = nextIdx++;
        if (i >= script.scenes.length) return;
        try {
          const r = await fetchClipForScene(script.scenes[i], {
            pexelsKey, pixabayKey, cacheDir,
            targetWidth, targetHeight,
          });
          if (r) clipFiles[i] = r.localPath;
        } catch (e) {
          log.warn('Clip fetch failed for scene', i, e.message);
        }
        update('clips', clipFiles.filter(Boolean).length / script.scenes.length);
      }
    });
    await Promise.all(workers);

    const ok = clipFiles.filter(Boolean).length;
    if (ok === 0) throw new Error('No stock footage available — check Pexels/Pixabay keys and search terms.');

    // For scenes with no clip, reuse a prior clip (last available before it)
    let lastGood = clipFiles.find(Boolean);
    for (let i = 0; i < clipFiles.length; i++) {
      if (clipFiles[i]) lastGood = clipFiles[i];
      else clipFiles[i] = lastGood;
    }
    update('clips', 1);

    // 3. TTS per scene
    const wantsTTS = mode.voice !== null;
    const narrationFiles = new Array(script.scenes.length).fill(null);
    if (wantsTTS) {
      update('tts', 0, { message: 'Generating voiceover...' });
      for (let i = 0; i < script.scenes.length; i++) {
        checkCancel();
        const text = script.scenes[i].narration;
        if (!text || !text.trim()) continue;
        const out = path.join(projectDir, `nar_${i}`);
        try {
          const f = await speakToFile({
            text,
            voice: voice || 'en-US-AriaNeural',
            rate: mode.voice?.rate || '+0%',
            pitch: mode.voice?.pitch || '+0Hz',
            outFile: out + '.mp3',
          });
          narrationFiles[i] = f;
        } catch (e) {
          log.warn('TTS failed for scene', i, e.message);
        }
        update('tts', (i + 1) / script.scenes.length);
      }
      update('tts', 1);
    }

    // 4. Music (best-effort, optional)
    update('music', 0, { message: 'Selecting music...' });
    const musicFile = await fetchMusicForVibe(mode.music.vibe, { pixabayKey, cacheDir });
    update('music', 1);

    // 5. Stitch
    update('stitch', 0, { message: 'Editing video...' });
    const out = await stitch({
      scenes: script.scenes,
      clipFiles,
      narrationFiles,
      musicFile,
      musicVolumeDb: mode.music.volumeDb,
      burnSubtitles: !!burnSubtitles && wantsTTS,
      width: targetWidth,
      height: targetHeight,
      outputDir: projectDir,
      outputName: 'output',
      onProgress: (p) => {
        const fract = p.stage === 'stitch:normalize' ? p.pct * 0.4
                    : p.stage === 'stitch:concat' ? 0.4 + p.pct * 0.05
                    : p.stage === 'stitch:audio' ? 0.45 + p.pct * 0.15
                    : p.stage === 'stitch:mux' ? 0.6 + p.pct * 0.4
                    : 0;
        update('stitch', fract);
      },
    });
    update('stitch', 1);

    // 6. Persist project metadata
    const meta = {
      id: projectId,
      createdAt: new Date().toISOString(),
      prompt,
      modeId,
      durationSec: effectiveDuration,
      voice: voice || 'en-US-AriaNeural',
      isShorts: wantsShorts,
      width: targetWidth,
      height: targetHeight,
      script,
      videoPath: out.videoPath,
      thumbPath: out.thumbPath,
      durationSeconds: out.durationSeconds,
    };
    fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(meta, null, 2));

    update('done', 1, { project: meta });
    return meta;
  } finally {
    _active = false;
    _cancelRequested = false;
  }
}

module.exports = { generate, isActive, requestCancel };
