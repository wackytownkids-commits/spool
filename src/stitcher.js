// Video stitcher — given clips, narration, optional music, optional subtitles,
// optional title overlays, produces a final MP4.

const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { runFfmpeg, ffprobeDuration } = require('./ffmpeg-runner');

// Trim/normalize each input clip to scene duration, scale to target, no audio
async function normalizeClip({ src, dest, duration, width, height }) {
  const args = [
    '-y', '-ss', '0', '-t', String(duration), '-i', src,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    dest,
  ];
  await runFfmpeg(args);
}

// Concatenate normalized clips
async function concatClips({ files, dest }) {
  const listFile = dest + '.list.txt';
  fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', dest,
  ];
  try { await runFfmpeg(args); }
  finally { try { fs.unlinkSync(listFile); } catch (_) {} }
}

// Merge per-scene narrations into one audio track aligned to scene boundaries.
// We pad each narration with silence so it slots into its scene window.
async function buildNarrationTrack({ scenes, narrationFiles, dest, totalDuration }) {
  // Build a filter graph that delays each narration to its start time and mixes them.
  const inputs = [];
  let filter = '';
  let cursor = 0;
  const used = [];
  scenes.forEach((s, i) => {
    const f = narrationFiles[i];
    if (f) {
      inputs.push('-i', f);
      const idx = used.length;
      const startMs = Math.round(cursor * 1000);
      filter += `[${idx}:a]adelay=${startMs}|${startMs}[a${idx}];`;
      used.push(idx);
    }
    cursor += s.duration_seconds;
  });
  if (used.length === 0) return null;
  const tags = used.map(i => `[a${i}]`).join('');
  filter += `${tags}amix=inputs=${used.length}:duration=longest:dropout_transition=0,apad=whole_dur=${totalDuration}[outa]`;

  const args = ['-y', ...inputs, '-filter_complex', filter, '-map', '[outa]',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(totalDuration), dest];
  await runFfmpeg(args);
  return dest;
}

// Mix narration with background music
async function mixAudio({ narrationFile, musicFile, musicVolumeDb, dest, totalDuration }) {
  if (!narrationFile && !musicFile) return null;
  if (narrationFile && !musicFile) return narrationFile;
  if (!narrationFile && musicFile) {
    const args = ['-y', '-i', musicFile,
      '-af', `volume=${dbToLinear(musicVolumeDb)},apad`,
      '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k', dest];
    await runFfmpeg(args);
    return dest;
  }
  // Both: duck music under narration
  const args = ['-y', '-i', narrationFile, '-i', musicFile,
    '-filter_complex',
      `[1:a]volume=${dbToLinear(musicVolumeDb)},aloop=loop=-1:size=2e9,atrim=0:${totalDuration}[bg];` +
      `[bg][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[duck];` +
      `[duck][0:a]amix=inputs=2:duration=first:dropout_transition=0[outa]`,
    '-map', '[outa]', '-t', String(totalDuration),
    '-c:a', 'aac', '-b:a', '192k', dest];
  await runFfmpeg(args);
  return dest;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20).toFixed(4);
}

function escapeFFText(t) {
  return String(t || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

// Build SRT from scene narrations (rough timing — assumes narration runs the full scene)
function buildSrt({ scenes, dest }) {
  let srt = '';
  let cursor = 0;
  let n = 1;
  for (const s of scenes) {
    if (!s.narration) { cursor += s.duration_seconds; continue; }
    const start = cursor;
    const end = cursor + s.duration_seconds;
    srt += `${n}\n${tcSrt(start)} --> ${tcSrt(end)}\n${wrapLines(s.narration, 42)}\n\n`;
    n++;
    cursor += s.duration_seconds;
  }
  fs.writeFileSync(dest, srt, 'utf8');
}

function tcSrt(s) {
  const ms = Math.round(s * 1000);
  const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const mmm = String(ms % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

function wrapLines(text, maxLen) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxLen) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

// Build final video: combine concatenated video + final audio + optional subtitle burn + title overlays
async function muxFinal({ videoFile, audioFile, subtitleFile, scenes, dest, totalDuration, onProgress }) {
  const inputs = ['-i', videoFile];
  if (audioFile) inputs.push('-i', audioFile);

  let vfilter = [];
  // Subtitles burn-in
  if (subtitleFile) {
    const sub = subtitleFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
    vfilter.push(
      `subtitles='${sub}':force_style='FontName=Inter,FontSize=22,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'`
    );
  }
  // Title overlays per scene
  const overlays = scenes
    .map((s, i) => ({ text: s.title_overlay, start: scenes.slice(0, i).reduce((a, x) => a + x.duration_seconds, 0), end: scenes.slice(0, i + 1).reduce((a, x) => a + x.duration_seconds, 0) }))
    .filter(o => o.text);
  for (const o of overlays) {
    vfilter.push(
      `drawtext=text='${escapeFFText(o.text)}':fontcolor=white:fontsize=72:` +
      `box=1:boxcolor=0x000000@0.55:boxborderw=24:` +
      `x=(w-text_w)/2:y=h-260:enable='between(t,${o.start},${o.end})'`
    );
  }

  const args = ['-y', ...inputs];
  if (vfilter.length > 0) {
    args.push('-vf', vfilter.join(','));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  if (audioFile) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  else args.push('-an');
  args.push('-t', String(totalDuration));
  args.push(dest);

  await runFfmpeg(args, { onProgress, totalSeconds: totalDuration });
}

// Capture a thumbnail at the midpoint
async function captureThumbnail({ videoFile, dest, atSeconds }) {
  const args = ['-y', '-ss', String(atSeconds || 1), '-i', videoFile,
    '-frames:v', '1', '-q:v', '2', dest];
  await runFfmpeg(args);
}

async function stitch({
  scenes,
  clipFiles,            // local paths from clip-fetcher, parallel to scenes
  narrationFiles,       // local paths or null per scene, parallel to scenes
  musicFile,            // optional bg music path
  musicVolumeDb,        // mode music volume
  burnSubtitles,        // boolean
  width, height,
  outputDir,
  outputName,
  onProgress,
}) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, `${outputName}.mp4`);
  const thumbPath = path.join(outputDir, `${outputName}.jpg`);
  const totalDuration = scenes.reduce((a, s) => a + s.duration_seconds, 0);

  // 1. Normalize each clip to scene duration
  onProgress?.({ stage: 'stitch:normalize', pct: 0 });
  const norms = [];
  for (let i = 0; i < scenes.length; i++) {
    const src = clipFiles[i];
    if (!src) continue;
    const out = path.join(outputDir, `_scene_${i}.mp4`);
    const probedDur = await ffprobeDuration(src).catch(() => 0);
    const useDur = probedDur > 0 ? Math.min(scenes[i].duration_seconds, probedDur) : scenes[i].duration_seconds;
    await normalizeClip({ src, dest: out, duration: useDur, width, height });
    norms.push(out);
    onProgress?.({ stage: 'stitch:normalize', pct: (i + 1) / scenes.length });
  }

  // 2. Concat
  onProgress?.({ stage: 'stitch:concat', pct: 0 });
  const concatPath = path.join(outputDir, '_concat.mp4');
  await concatClips({ files: norms, dest: concatPath });
  onProgress?.({ stage: 'stitch:concat', pct: 1 });

  // 3. Build narration track (if any)
  onProgress?.({ stage: 'stitch:audio', pct: 0 });
  const hasNarration = narrationFiles?.some(Boolean);
  let narrationTrack = null;
  if (hasNarration) {
    narrationTrack = path.join(outputDir, '_narration.m4a');
    await buildNarrationTrack({ scenes, narrationFiles, dest: narrationTrack, totalDuration });
  }

  // 4. Mix narration + music
  let finalAudio = null;
  if (narrationTrack || musicFile) {
    finalAudio = await mixAudio({
      narrationFile: narrationTrack,
      musicFile,
      musicVolumeDb: musicVolumeDb ?? -18,
      dest: path.join(outputDir, '_audio.m4a'),
      totalDuration,
    });
  }
  onProgress?.({ stage: 'stitch:audio', pct: 1 });

  // 5. Subtitles (optional)
  let subtitleFile = null;
  if (burnSubtitles && hasNarration) {
    subtitleFile = path.join(outputDir, '_subs.srt');
    buildSrt({ scenes, dest: subtitleFile });
  }

  // 6. Mux final
  onProgress?.({ stage: 'stitch:mux', pct: 0 });
  await muxFinal({
    videoFile: concatPath,
    audioFile: finalAudio,
    subtitleFile,
    scenes,
    dest: finalPath,
    totalDuration,
    onProgress: (p) => onProgress?.({ stage: 'stitch:mux', pct: p }),
  });

  // 7. Thumbnail
  await captureThumbnail({ videoFile: finalPath, dest: thumbPath, atSeconds: Math.min(totalDuration / 3, 5) });

  // Cleanup intermediates
  for (const f of norms) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.unlinkSync(concatPath); } catch (_) {}
  if (narrationTrack) { try { fs.unlinkSync(narrationTrack); } catch (_) {} }
  if (finalAudio && finalAudio !== narrationTrack) { try { fs.unlinkSync(finalAudio); } catch (_) {} }
  if (subtitleFile) { try { fs.unlinkSync(subtitleFile); } catch (_) {} }

  return { videoPath: finalPath, thumbPath, durationSeconds: totalDuration };
}

module.exports = { stitch };
