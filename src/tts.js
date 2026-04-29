// Text-to-speech via msedge-tts. Free, no key, ~200 neural voices.
// Defensive: if WS handshake fails (network or upstream tightening), we throw
// a clear error so the pipeline can downgrade to no-narration.

const fs = require('fs');
const path = require('path');
const log = require('electron-log');

let MsEdgeTTS, OUTPUT_FORMAT;
try {
  ({ MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts'));
} catch (e) {
  log.warn('msedge-tts not available:', e.message);
}

const FREE_VOICES = [
  'en-US-AriaNeural',
  'en-US-GuyNeural',
  'en-US-JennyNeural',
  'en-US-DavisNeural',
  'en-US-AndrewNeural',
  'en-US-EmmaNeural',
  'en-GB-SoniaNeural',
  'en-GB-RyanNeural',
  'en-AU-NatashaNeural',
  'en-AU-WilliamNeural',
];

async function listVoices() {
  if (!MsEdgeTTS) return FREE_VOICES.map(shortVoice);
  try {
    const tts = new MsEdgeTTS();
    const all = await tts.getVoices();
    return all
      .filter(v => v.Locale && v.ShortName)
      .map((v) => ({
        shortName: v.ShortName,
        displayName: v.LocalName || v.FriendlyName || v.ShortName,
        locale: v.Locale,
        gender: v.Gender,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale) || a.shortName.localeCompare(b.shortName));
  } catch (e) {
    log.warn('listVoices fallback:', e.message);
    return FREE_VOICES.map(shortVoice);
  }
}

function shortVoice(name) {
  return { shortName: name, displayName: name, locale: name.split('-').slice(0, 2).join('-'), gender: '' };
}

async function speakToFile({ text, voice, rate = '+0%', pitch = '+0Hz', outFile }) {
  if (!MsEdgeTTS) throw new Error('msedge-tts unavailable');
  if (!text || !text.trim()) throw new Error('empty text');

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice || 'en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // msedge-tts.toFile takes a DIRECTORY (it writes a randomly-named .mp3
  // inside). We synthesize into a temp dir, then move the result to outFile.
  const tmpDir = path.join(path.dirname(outFile), `_tts_${path.basename(outFile, path.extname(outFile))}_${Date.now().toString(36)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dir = path.dirname(outFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let writtenPath;
  try {
    const result = await tts.toFile(tmpDir, text, { rate, pitch });
    writtenPath = result.audioFilePath;
    if (!writtenPath || !fs.existsSync(writtenPath)) {
      // Fallback: pick first .mp3 in the temp dir
      const list = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp3'));
      if (list.length === 0) throw new Error('TTS produced no file');
      writtenPath = path.join(tmpDir, list[0]);
    }
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    fs.renameSync(writtenPath, outFile);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  return outFile;
}

module.exports = { listVoices, speakToFile, FREE_VOICES };
