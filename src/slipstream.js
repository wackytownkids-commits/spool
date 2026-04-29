// Slipstream — poll YouTube RSS for source channels every 15 min, generate an
// "inspired-by" prompt via LLM, run normal pipeline + auto-upload.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const log = require('electron-log');
const { slipstreamPrompt } = require('./prompt-fanout');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const RSS_BASE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

let _state = { sources: [] };
let _file;
let _onChange = () => {};
let _processSource = async () => {};
let _timer = null;

function init({ file, processSource, onChange }) {
  _file = file;
  _processSource = processSource;
  _onChange = onChange || (() => {});
  load();
  // Begin polling cycle in 30s to let app finish booting
  schedule(30_000);
}

function load() {
  try {
    if (fs.existsSync(_file)) {
      const j = JSON.parse(fs.readFileSync(_file, 'utf8'));
      if (j && Array.isArray(j.sources)) _state = j;
    }
  } catch (e) {
    log.warn('slipstream load failed:', e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    fs.writeFileSync(_file, JSON.stringify(_state, null, 2));
    _onChange(getSources());
  } catch (e) {
    log.warn('slipstream save failed:', e.message);
  }
}

function getSources() {
  return _state.sources.map(s => ({ ...s }));
}

// Channel URL/handle parser. Accepts:
//   https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
//   https://www.youtube.com/@handle
//   https://www.youtube.com/c/CustomName
//   https://www.youtube.com/user/LegacyName
//   m.youtube.com / youtube.com / mobile / share-link variants
//   bare @handle  (no domain)
//   bare UC... id
//
// Returns { ok: true, channelId, title } on success, { ok: false, error: '...' } on failure.

const HEADERS_FOR_SCRAPE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  // CONSENT cookie bypasses Google's EU consent wall, which otherwise serves
  // a mostly-empty interstitial page that has no channelId in it.
  'Cookie': 'CONSENT=YES+1; SOCS=CAI',
};

// Try multiple regex patterns — Google has changed the inline JSON shape over
// the years, and different page templates use different markers. We try them
// from most-specific to most-permissive.
const CHANNEL_ID_PATTERNS = [
  /<meta\s+itemprop="(?:channelId|identifier)"\s+content="(UC[\w-]{20,})"/,
  /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})"/,
  /"channelId":"(UC[\w-]{20,})"/,
  /"externalChannelId":"(UC[\w-]{20,})"/,
  /"externalId":"(UC[\w-]{20,})"/,
  /"browseId":"(UC[\w-]{20,})"/,
  /\/channel\/(UC[\w-]{20,})/, // last-ditch: any /channel/UC... ref in the HTML
];

function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Strip leading @ that's a bare handle (no protocol)
  if (s.startsWith('@') && !s.includes('/') && !s.includes('.')) {
    return 'https://www.youtube.com/' + s;
  }
  // youtu.be doesn't host channel pages; only video shortlinks. Reject early.
  if (/youtu\.be\//.test(s)) return s; // let the resolver fail with a useful message
  // Add https:// if missing
  if (!/^https?:\/\//i.test(s) && (s.includes('youtube.com') || s.startsWith('@'))) {
    s = 'https://' + s.replace(/^\/+/, '');
  }
  // Normalize mobile -> desktop
  s = s.replace(/^https?:\/\/m\.youtube\.com/i, 'https://www.youtube.com');
  s = s.replace(/^https?:\/\/youtube\.com/i, 'https://www.youtube.com');
  // Strip trailing slashes, hash fragments, and query strings (?si=, ?feature=share, etc.)
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch (_) {
    return s.replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

async function fetchChannelPage(url) {
  // Two-pass fetch: regular page first; if no channelId found, try the
  // /about page which is more stable across template changes.
  const tries = [url, url.endsWith('/about') ? null : url.replace(/\/$/, '') + '/about'].filter(Boolean);
  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: HEADERS_FOR_SCRAPE, redirect: 'follow' });
      if (!r.ok) continue;
      const html = await r.text();
      for (const re of CHANNEL_ID_PATTERNS) {
        const m = html.match(re);
        if (m && m[1]) return m[1];
      }
    } catch (e) {
      log.warn('channel page fetch failed:', u, e.message);
    }
  }
  return null;
}

async function fetchChannelTitle(channelId) {
  try {
    const r = await fetch(RSS_BASE + channelId, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) return null;
    const xml = await r.text();
    const author = xml.match(/<author>\s*<name>([^<]+)<\/name>/);
    if (author) return author[1];
    const t = xml.match(/<title>([^<]+)<\/title>/);
    return t ? t[1] : null;
  } catch (_) { return null; }
}

async function resolveChannel(input) {
  if (!input) return { ok: false, error: 'Empty input.' };
  const normalized = normalizeInput(input);

  // Reject youtu.be early with a clear message
  if (/youtu\.be\//.test(normalized)) {
    return { ok: false, error: "youtu.be links are video shortcuts, not channels. Paste the channel URL like youtube.com/@channelname." };
  }

  let channelId = null;

  // 1. Bare UC... ID
  if (/^UC[\w-]{20,}$/.test(input.trim())) {
    channelId = input.trim();
  }

  // 2. /channel/UC... in the URL
  if (!channelId) {
    const m = normalized.match(/\/channel\/(UC[\w-]{20,})/);
    if (m) channelId = m[1];
  }

  // 3. /@handle, /c/customname, /user/legacyname → scrape page for channelId
  if (!channelId && /youtube\.com\/(?:@|c\/|user\/)/i.test(normalized)) {
    channelId = await fetchChannelPage(normalized);
  }

  // 4. Generic youtube.com/something fallback — try scraping in case it's an
  // unusual URL shape we didn't anticipate
  if (!channelId && /youtube\.com\//i.test(normalized)) {
    channelId = await fetchChannelPage(normalized);
  }

  if (!channelId) {
    return {
      ok: false,
      error: `Couldn't resolve "${input}". Try the full URL like youtube.com/@channelname or youtube.com/channel/UC...`,
    };
  }

  // Pull a friendly title from the RSS feed
  const title = await fetchChannelTitle(channelId);
  return { ok: true, channelId, title: title || channelId };
}

// Heuristic format detection — probes the latest 5 video IDs from the source's
// RSS feed and asks each whether it's a Short. Cheap, no quota.
//
// Mechanism: requesting https://www.youtube.com/shorts/{id} returns a Shorts
// page only if the video IS a Short. For long-form videos, YouTube redirects
// to /watch?v={id}. We do a redirect-following fetch and check the final URL.
async function detectChannelFormat(channelId) {
  try {
    const rss = await fetch(RSS_BASE + channelId, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!rss.ok) return 'unknown';
    const xml = await rss.text();
    const ids = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].slice(0, 5).map(m => m[1]);
    if (ids.length === 0) return 'unknown';
    let shortsHits = 0;
    for (const id of ids) {
      try {
        const r = await fetch('https://www.youtube.com/shorts/' + id, {
          method: 'HEAD',
          headers: HEADERS_FOR_SCRAPE,
          redirect: 'follow',
        });
        // If the final URL still contains /shorts/, it's a Short. If it
        // redirected to /watch, it's long-form.
        if (/\/shorts\//.test(r.url || '')) shortsHits++;
      } catch (_) {}
    }
    if (shortsHits >= Math.ceil(ids.length / 2)) return 'shorts';
    return 'longform';
  } catch (_) {
    return 'unknown';
  }
}

async function addSource(input) {
  const r = await resolveChannel(input);
  if (!r.ok) return r;
  if (_state.sources.some(s => s.channelId === r.channelId)) {
    return { ok: false, error: 'Channel already added.' };
  }
  // Detect the source's preferred format up front so generated Slipstream
  // videos match the source's vibe (shorts channel → shorts; vlog channel
  // → long-form). Best-effort; falls back to 'unknown' on any failure.
  const preferredFormat = await detectChannelFormat(r.channelId);
  _state.sources.push({
    channelId: r.channelId,
    title: r.title,
    paused: false,
    addedAt: Date.now(),
    lastPolledAt: 0,
    lastSeenVideoId: null,
    lastError: null,
    processedCount: 0,
    preferredFormat,        // 'shorts' | 'longform' | 'unknown'
  });
  save();
  return { ok: true, source: _state.sources[_state.sources.length - 1] };
}

function removeSource(channelId) {
  const before = _state.sources.length;
  _state.sources = _state.sources.filter(s => s.channelId !== channelId);
  if (_state.sources.length !== before) save();
}

function setPaused(channelId, paused) {
  const s = _state.sources.find(x => x.channelId === channelId);
  if (s) { s.paused = !!paused; save(); }
}

function parseRssEntries(xml) {
  // Lightweight XML scan — yt:videoId tag is unique per entry
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const id = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([^<]+)<\/title>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id && title) out.push({ id, title, published });
  }
  return out;
}

async function pollSource(s) {
  if (s.paused) return null;
  try {
    const r = await fetch(RSS_BASE + s.channelId);
    if (!r.ok) {
      s.lastError = `rss http ${r.status}`;
      save();
      return null;
    }
    const xml = await r.text();
    s.lastPolledAt = Date.now();
    s.lastError = null;
    const entries = parseRssEntries(xml);
    if (entries.length === 0) { save(); return null; }
    // First entry is the newest. If we have a lastSeenVideoId and it matches → no new video.
    const newest = entries[0];
    if (s.lastSeenVideoId === newest.id) { save(); return null; }
    // First-time addition: seed with newest, don't process
    if (!s.lastSeenVideoId) {
      s.lastSeenVideoId = newest.id;
      save();
      return null;
    }
    // Find new entries since lastSeen
    const newOnes = [];
    for (const e of entries) {
      if (e.id === s.lastSeenVideoId) break;
      newOnes.push(e);
    }
    s.lastSeenVideoId = newest.id;
    save();
    return newOnes; // newest first
  } catch (e) {
    s.lastError = e.message;
    save();
    return null;
  }
}

async function tick() {
  for (const s of _state.sources) {
    if (s.paused) continue;
    const fresh = await pollSource(s);
    if (!fresh || fresh.length === 0) continue;
    // Process from oldest to newest to preserve chronology
    for (const entry of fresh.reverse()) {
      try {
        const prompt = await slipstreamPrompt(entry.title);
        if (!prompt) {
          log.warn('slipstream: no prompt generated for', entry.title);
          continue;
        }
        log.info('slipstream:', s.title, '→', prompt);
        await _processSource({
          sourceChannelId: s.channelId,
          sourceVideoId: entry.id,
          sourceTitle: entry.title,
          prompt,
          preferredFormat: s.preferredFormat || 'unknown',
        });
        s.processedCount = (s.processedCount || 0) + 1;
        save();
      } catch (e) {
        log.error('slipstream process failed:', e);
      }
    }
  }
}

function schedule(delay) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    try { await tick(); }
    catch (e) { log.error('slipstream tick error', e); }
    schedule(POLL_INTERVAL_MS);
  }, delay);
}

module.exports = { init, addSource, removeSource, setPaused, getSources, resolveChannel };
