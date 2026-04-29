// Stock clip fetcher — queries Pexels Videos and Pixabay, scores results,
// downloads the best fit per scene to the cache dir.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('electron-log');

const PEXELS_SEARCH = 'https://api.pexels.com/videos/search';
const PIXABAY_SEARCH = 'https://pixabay.com/api/videos/';

async function searchPexels(query, perPage, key) {
  if (!key) return [];
  try {
    const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(query)}&per_page=${perPage}&size=medium`;
    const r = await fetch(url, { headers: { Authorization: key } });
    if (!r.ok) {
      log.warn('Pexels error', r.status);
      return [];
    }
    const j = await r.json();
    return (j.videos || []).map((v) => normalizePexels(v));
  } catch (e) {
    log.warn('Pexels fetch failed', e.message);
    return [];
  }
}

function normalizePexels(v) {
  const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4');
  // Prefer 1080p HD, then 720p, then anything
  const ranked = files.slice().sort((a, b) => {
    const sa = scoreFile(a);
    const sb = scoreFile(b);
    return sb - sa;
  });
  const pick = ranked[0];
  if (!pick) return null;
  return {
    source: 'pexels',
    id: `pexels_${v.id}`,
    width: pick.width,
    height: pick.height,
    duration: v.duration,
    url: pick.link,
    thumb: v.image,
  };
}

function scoreFile(f) {
  let s = 0;
  if (f.width >= 1920) s += 100;
  else if (f.width >= 1280) s += 60;
  else if (f.width >= 854) s += 30;
  if (f.quality === 'hd') s += 10;
  return s;
}

async function searchPixabay(query, perPage, key) {
  if (!key) return [];
  try {
    const url = `${PIXABAY_SEARCH}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPage}&video_type=film`;
    const r = await fetch(url);
    if (!r.ok) {
      log.warn('Pixabay error', r.status);
      return [];
    }
    const j = await r.json();
    return (j.hits || []).map((v) => normalizePixabay(v)).filter(Boolean);
  } catch (e) {
    log.warn('Pixabay fetch failed', e.message);
    return [];
  }
}

function normalizePixabay(v) {
  const variants = v.videos || {};
  // Prefer large -> medium -> small -> tiny
  const order = ['large', 'medium', 'small', 'tiny'];
  let pick = null;
  for (const k of order) {
    if (variants[k] && variants[k].url) { pick = variants[k]; break; }
  }
  if (!pick) return null;
  return {
    source: 'pixabay',
    id: `pixabay_${v.id}`,
    width: pick.width,
    height: pick.height,
    duration: v.duration,
    url: pick.url,
    thumb: v.picture_id ? `https://i.vimeocdn.com/video/${v.picture_id}_640x360.jpg` : '',
  };
}

function scoreClip(clip, scene, targetWidth, targetHeight) {
  if (!clip) return -1;
  let s = 0;
  // Resolution
  if (clip.width >= 1920) s += 50;
  else if (clip.width >= 1280) s += 30;
  else if (clip.width >= 854) s += 15;
  // Aspect match
  const targetAspect = targetWidth / targetHeight;
  const clipAspect = clip.width / clip.height;
  const aspectDelta = Math.abs(clipAspect - targetAspect);
  s += Math.max(0, 30 - aspectDelta * 30);
  // Duration: clip should be at least scene duration; reward extra headroom up to 2x
  const need = scene.duration_seconds || 5;
  if (clip.duration >= need) {
    s += 20;
    if (clip.duration <= need * 2) s += 10;
  } else {
    s -= (need - clip.duration) * 5;
  }
  return s;
}

async function downloadFile(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download http ${r.status}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    r.body.pipe(out);
    r.body.on('error', reject);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return dest;
}

async function fetchClipForScene(scene, opts) {
  const { pexelsKey, pixabayKey, cacheDir, targetWidth, targetHeight } = opts;
  const queries = uniq([
    scene.search_query,
    scene.search_query?.replace(/[,.!?]/g, '').trim(),
    scene.title_overlay,
  ].filter(q => q && q.length > 1));

  let candidates = [];
  for (const q of queries) {
    if (candidates.length >= 8) break;
    const [px, pb] = await Promise.all([
      searchPexels(q, 6, pexelsKey),
      searchPixabay(q, 6, pixabayKey),
    ]);
    candidates = candidates.concat(px.filter(Boolean), pb.filter(Boolean));
  }

  // Dedupe by id
  const seen = new Set();
  candidates = candidates.filter(c => {
    if (!c) return false;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  if (candidates.length === 0) {
    log.warn('No clips found for', scene.search_query);
    return null;
  }

  candidates.sort((a, b) => scoreClip(b, scene, targetWidth, targetHeight) - scoreClip(a, scene, targetWidth, targetHeight));
  const pick = candidates[0];

  // Download to cache
  const filename = `${pick.id}_${crypto.randomBytes(3).toString('hex')}.mp4`;
  const dest = path.join(cacheDir, filename);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  await downloadFile(pick.url, dest);
  return { ...pick, localPath: dest };
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

module.exports = { fetchClipForScene };
