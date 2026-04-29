// Auto-Batch queue — persisted JSON list of {prompt, status, dueAt, ...} items.
// On app boot, the scheduler resumes; it processes one item at a time, sequentially.
// If the user was offline, overdue items fire with 5-minute spacing instead of all at once.

const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { fanoutPrompts } = require('./prompt-fanout');

const CATCHUP_SPACING_MS = 5 * 60 * 1000; // 5 min between catch-up items

let _state = {
  batches: [], // [{ id, seed, createdAt, modeId, durationSec, voice, visibility, intervalMs, items: [...] }]
};
let _file;
let _dirty = false;
let _runner = null;
let _onChange = () => {};
let _processItem = async () => ({ ok: false, error: 'not wired' });

function init({ file, processItem, onChange }) {
  _file = file;
  _processItem = processItem;
  _onChange = onChange || (() => {});
  load();
  // schedule next tick
  setTimeout(tick, 1000);
}

function load() {
  try {
    if (fs.existsSync(_file)) {
      const j = JSON.parse(fs.readFileSync(_file, 'utf8'));
      if (j && Array.isArray(j.batches)) _state = j;
    }
  } catch (e) {
    log.warn('queue load failed:', e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    fs.writeFileSync(_file, JSON.stringify(_state, null, 2));
    _dirty = false;
    _onChange(getQueue());
  } catch (e) {
    log.warn('queue save failed:', e.message);
  }
}

function getQueue() {
  // Flat view of batches + items, with derived fields
  return _state.batches.map(b => ({ ...b, items: b.items.map(it => ({ ...it })) }));
}

async function createBatch({ seed, count, intervalMs, modeId, durationSec, voice, visibility, burnSubtitles, isShorts }) {
  const prompts = await fanoutPrompts(seed, count);
  const id = `b_${Date.now().toString(36)}`;
  const now = Date.now();
  const items = prompts.map((p, i) => ({
    id: `${id}_i${i}`,
    prompt: p,
    status: 'pending',  // pending | generating | uploading | done | failed | skipped
    dueAt: now + i * intervalMs,
    createdAt: now,
    error: null,
    videoId: null,
    url: null,
    projectId: null,
  }));
  _state.batches.unshift({
    id, seed, count, intervalMs,
    modeId, durationSec, voice, visibility, burnSubtitles,
    isShorts: !!isShorts,
    createdAt: now,
    items,
  });
  save();
  // Kick the scheduler immediately
  setTimeout(tick, 100);
  return id;
}

function deleteBatch(batchId) {
  const before = _state.batches.length;
  _state.batches = _state.batches.filter(b => b.id !== batchId);
  if (_state.batches.length !== before) save();
}

function setItemStatus(batchId, itemId, patch) {
  const b = _state.batches.find(x => x.id === batchId);
  if (!b) return;
  const it = b.items.find(x => x.id === itemId);
  if (!it) return;
  Object.assign(it, patch);
  save();
}

function skipItem(batchId, itemId) {
  setItemStatus(batchId, itemId, { status: 'skipped' });
  setTimeout(tick, 50);
}

function findNextDue(now) {
  // Pick the single most-overdue pending item across all batches.
  let pick = null;
  for (const b of _state.batches) {
    for (const it of b.items) {
      if (it.status !== 'pending') continue;
      if (it.dueAt > now) continue;
      if (!pick || it.dueAt < pick.it.dueAt) pick = { b, it };
    }
  }
  return pick;
}

function findNextUpcoming(now) {
  let pick = null;
  for (const b of _state.batches) {
    for (const it of b.items) {
      if (it.status !== 'pending') continue;
      if (it.dueAt <= now) continue;
      if (!pick || it.dueAt < pick.it.dueAt) pick = { b, it };
    }
  }
  return pick;
}

async function tick() {
  if (_runner) return; // already processing
  const now = Date.now();
  const due = findNextDue(now);
  if (!due) {
    const next = findNextUpcoming(now);
    if (next) {
      const wait = Math.max(1000, next.it.dueAt - now);
      setTimeout(tick, Math.min(wait, 60_000));
    }
    return;
  }
  _runner = (async () => {
    try {
      const { b, it } = due;
      log.info('queue: processing', it.id, '—', it.prompt);
      setItemStatus(b.id, it.id, { status: 'generating' });
      const r = await _processItem({
        prompt: it.prompt,
        modeId: b.modeId,
        durationSec: b.durationSec,
        voice: b.voice,
        burnSubtitles: b.burnSubtitles,
        visibility: b.visibility,
        isShorts: b.isShorts,
      });
      if (r.ok) {
        setItemStatus(b.id, it.id, {
          status: r.uploadOk === false ? 'failed' : 'done',
          videoId: r.videoId || null,
          url: r.url || null,
          projectId: r.projectId || null,
          error: r.uploadOk === false ? (r.uploadError || 'upload failed') : null,
        });
      } else {
        setItemStatus(b.id, it.id, { status: 'failed', error: r.error || 'unknown' });
      }
    } catch (e) {
      log.error('queue tick error', e);
    } finally {
      _runner = null;
      // Re-schedule next tick. If next due is in the past (catch-up), space by 5 min.
      const now2 = Date.now();
      const due2 = findNextDue(now2);
      if (due2) {
        // Catch-up spacing: shift the next due to now + spacing if it was already overdue.
        if (now2 - due2.it.dueAt > 0) {
          const newDueAt = now2 + CATCHUP_SPACING_MS;
          setItemStatus(due2.b.id, due2.it.id, { dueAt: newDueAt });
          setTimeout(tick, CATCHUP_SPACING_MS);
        } else {
          setTimeout(tick, Math.max(1000, due2.it.dueAt - now2));
        }
      } else {
        const upc = findNextUpcoming(now2);
        if (upc) setTimeout(tick, Math.min(60_000, Math.max(1000, upc.it.dueAt - now2)));
      }
    }
  })();
}

module.exports = { init, getQueue, createBatch, deleteBatch, skipItem };
