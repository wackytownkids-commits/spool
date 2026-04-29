// Thin wrapper around ffmpeg/ffprobe binaries from ffmpeg-static / ffprobe-static.
// Resolves the asar-unpacked path correctly when running from an installed build.

const path = require('path');
const { spawn } = require('child_process');
const log = require('electron-log');

function resolveBinary(staticModule, fieldOrPath) {
  // ffmpeg-static exports a string path; ffprobe-static exports { path }.
  const raw = typeof staticModule === 'string' ? staticModule : staticModule.path || staticModule;
  // When packed in asar, ffmpeg-static path will be inside app.asar — but we
  // configured asarUnpack so the real binary lives at app.asar.unpacked/...
  return raw.replace('app.asar', 'app.asar.unpacked');
}

let _ffmpegPath, _ffprobePath;
function ffmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  _ffmpegPath = resolveBinary(require('ffmpeg-static'));
  return _ffmpegPath;
}
function ffprobePath() {
  if (_ffprobePath) return _ffprobePath;
  _ffprobePath = resolveBinary(require('ffprobe-static'));
  return _ffprobePath;
}

function runFfmpeg(args, { onProgress, totalSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress && totalSeconds) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(1, t / totalSeconds));
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        log.error('ffmpeg failed', code, '\n', stderr.slice(-2000));
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];
    const proc = spawn(ffprobePath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(e); }
    });
  });
}

async function probeDuration(file) {
  const j = await ffprobe(file);
  const d = parseFloat(j.format?.duration);
  return Number.isFinite(d) ? d : 0;
}

module.exports = { runFfmpeg, ffprobe, ffprobeDuration: probeDuration, ffmpegPath, ffprobePath };
