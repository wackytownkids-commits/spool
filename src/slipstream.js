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

// Channel URL parser — accepts:
//   https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
//   https://www.youtube.com/@handle
//   https://www.youtube.com/c/CustomName
//   raw UC... id
async function resolveChannel(input) {
  if (!input) return null;
  let id = null;
  const trimmed = input.trim();
  // Direct UC ID
  if (/^UC[\w-]{20,}$/.test(trimmed)) id = trimmed;
  // Channel URL
  const idMatch = trimmed.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (idMatch) id = idMatch[1];

  if (!id) {
    // Handle URLs (@username) and custom URLs (/c/name) — fetch the HTML and extract channel ID.
    const url = trimmed.startsWith('http') ? trimmed : `https://www.youtube.com/${trimmed.replace(/^\//, '')}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      const html = await r.text();
      const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/<meta itemprop="channelId" content="(UC[\w-]+)"/);
      if (m) id = m[1];
    } catch (e) {
      log.warn('channel resolve failed:', e.message);
      return null;
    }
  }
  if (!id) return null;

  // Fetch RSS to get title + thumbnail
  try {
    const r = await fetch(RSS_BASE + id);
    if (!r.ok) return null;
    const xml = await r.text();
    const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
    const linkMatch = xml.match(/<author>\s*<name>([^<]+)<\/name>/);
    return {
      channelId: id,
      title: linkMatch?.[1] || titleMatch?.[1] || id,
    };
  } catch (e) {
    return { channelId: id, title: id };
  }
}

async function addSource(input) {
  const c = await resolveChannel(input);
  if (!c) return { ok: false, error: 'Could not resolve channel.' };
  if (_state.sources.some(s => s.channelId === c.channelId)) {
    return { ok: false, error: 'Channel already added.' };
  }
  _state.sources.push({
    channelId: c.channelId,
    title: c.title,
    paused: false,
    addedAt: Date.now(),
    lastPolledAt: 0,
    lastSeenVideoId: null,
    lastError: null,
    processedCount: 0,
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
