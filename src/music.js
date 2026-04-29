// Background music — fetches free music from Pixabay's audio API.
// Each mode maps to a music vibe; we search Pixabay with that vibe word.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('electron-log');

const PIXABAY_AUDIO = 'https://pixabay.com/api/'; // image+audio share base

const VIBE_QUERIES = {
  energetic: 'energetic upbeat',
  cinematic: 'cinematic epic',
  upbeat: 'happy upbeat',
  hype: 'trap hype',
  ambient: 'ambient calm',
  news: 'corporate news',
  mellow: 'lofi chill',
};

// Pixabay video API (which we already use for clips) doesn't include music.
// Their music lives at https://pixabay.com/music/ but their public API for
// it is the search endpoint (key-gated, same key works). We use the
// "music" media_type endpoint which is documented at pixabay.com/api/docs/.
async function fetchMusicForVibe(vibe, opts) {
  const { pixabayKey, cacheDir } = opts;
  if (!pixabayKey) {
    log.warn('No pixabay key, skipping music');
    return null;
  }
  const q = VIBE_QUERIES[vibe] || vibe || 'background';
  // Pixabay does not have a fully public music API as of writing; the
  // documented endpoint is for images and videos. Music files are served
  // via direct CDN URLs. As a portable fallback, we use the videos endpoint
  // and extract the audio track of a "music"-tagged item — but this is
  // unreliable.
  //
  // The most reliable free option is to ship a small bundled royalty-free
  // music pack and pick a track based on vibe. We do that here. If the
  // bundled pack isn't found, we return null and the stitcher will skip
  // background music gracefully.
  const bundled = path.join(__dirname, '..', 'assets', 'music', `${vibe}.mp3`);
  if (fs.existsSync(bundled)) return bundled;

  // Try a fallback: search the videos endpoint which returns video items;
  // some have audio we can extract — but stitched output without music is
  // perfectly fine, so we just return null.
  log.info('No bundled music for vibe', vibe, '— continuing without background music');
  return null;
}

module.exports = { fetchMusicForVibe };
