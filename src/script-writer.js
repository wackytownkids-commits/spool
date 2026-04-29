// Script writer — generates a structured video script from the user's prompt.
// Calls Pollinations.ai (free, no key) with a tiered model chain:
//   1. openai-large (GPT-4o class) — best quality
//   2. openai (default) — reliable fallback
//   3. Strong deterministic fallback as last resort
//
// All raw LLM responses are written to %APPDATA%/Spool/logs/script-writer.log
// so failures can be diagnosed after the fact. Output goes through a strict
// validator that rejects placeholder/template tokens, too-short narration,
// and prompt-echo. Bad responses trigger a retry with a stricter system prompt.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { getMode } = require('./modes');

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';

// Models we try, in order. The first that returns valid content wins.
// As of writing, Pollinations' free anonymous tier only exposes 'openai'
// (alias of openai-fast = GPT-OSS 20B Reasoning on OVH). 'openai-large'
// is a paid-tier model that 404s anonymously. We keep the chain a list
// for future expansion if Pollinations adds more free models.
const MODEL_CHAIN = ['openai'];

// One-shot example baked into the system prompt. Concrete > abstract for
// instruction-tuned models — they imitate the example structure.
const ONE_SHOT_EXAMPLE = `EXAMPLE — for the topic "deepest known underwater cave":
{
  "title": "Inside The Deepest Underwater Cave Ever Mapped",
  "description": "Hranice Abyss in the Czech Republic plunges over 1,200 meters and divers still haven't reached the bottom. Here's what we know.",
  "tags": ["hranice abyss","cave diving","underwater","czech republic","exploration","geology"],
  "scenes": [
    {
      "narration": "Hranice Abyss is the deepest flooded cave on Earth — at least 1,200 meters down, and divers have only reached 473.",
      "title_overlay": "Hranice Abyss",
      "search_query": "underwater cave entrance dark water",
      "duration_seconds": 6
    },
    {
      "narration": "It sits in the Czech Republic and was carved out by warm acidic water rising from below, dissolving the limestone over millions of years.",
      "title_overlay": "Carved By Acid",
      "search_query": "limestone cave water erosion",
      "duration_seconds": 6
    },
    {
      "narration": "The current depth record was set by an ROV in 2016 — and it still didn't hit bottom.",
      "title_overlay": "Still Unmeasured",
      "search_query": "ROV submersible deep diving",
      "duration_seconds": 6
    }
  ]
}`;

const HARD_RULES = `Hard rules — non-negotiable:
- Use REAL named entities, places, dates, people, numbers. For "largest star" you must reference actual star names like UY Scuti, Stephenson 2-18, or VY Canis Majoris. Never write "the star" when a specific name exists.
- NO placeholder tokens. Never write {something}, [something], _____, XXXX, "blank", "TBD", "(insert ...)", or any template syntax. Every sentence must read as final, ready-to-narrate prose.
- NO generic filler like "this is amazing" or "you won't believe". Cite specific facts.
- NO repeating the user's prompt back as narration. Each narration must add new information.
- Narration sentences are short (8-22 words) and conversational.
- Output ONLY the JSON object. No markdown fence. No commentary. Start with { end with }.`;

// ---------- Validation ----------

const PLACEHOLDER_PATTERNS = [
  /\b(?:blank|tbd|placeholder|insert\s+\w+|todo|fixme|lorem|ipsum)\b/i,
  /\{[A-Za-z_][\w\s]*\}/,                      // {something} template token
  /\[[A-Z][\w\s]*\]/,                          // [SOMETHING] token
  /_{3,}/,                                      // ___
  /X{3,}/,                                      // XXX
  /<[a-z][^>]*>/i,                             // <tag> bleed
];

function validateScene(scene, prompt) {
  const t = String(scene.narration || '').trim();
  if (!scene.narration) {
    // Music-only modes legitimately have no narration; skip text checks.
    return null;
  }
  if (t.length < 15) return 'narration too short';
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(t)) return 'placeholder token in narration: ' + (t.match(re)?.[0] || '?');
  }
  // Reject if narration is essentially just an echo of the user prompt
  const np = prompt.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const ns = t.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (np.length > 8 && ns === np) return 'narration is just the prompt';
  return null;
}

function validateScript(parsed, prompt) {
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    return 'no scenes';
  }
  const errs = [];
  parsed.scenes.forEach((s, i) => {
    const e = validateScene(s, prompt);
    if (e) errs.push(`scene ${i + 1}: ${e}`);
  });
  if (errs.length > 0) return errs.join('; ');
  return null;
}

// ---------- LLM I/O ----------

let _logPath;
function setLogPath(p) { _logPath = p; }
function appendScriptLog(entry) {
  if (!_logPath) return;
  try {
    fs.mkdirSync(path.dirname(_logPath), { recursive: true });
    fs.appendFileSync(_logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    log.warn('script-writer log write failed:', e.message);
  }
}

function buildSystemPrompt(modeSystemPrompt, strict) {
  return [
    modeSystemPrompt,
    '',
    HARD_RULES,
    strict ? '\nThis is a RETRY because the previous response had placeholder tokens or generic filler. Be even more specific and concrete. Cite real names and real numbers.' : '',
    '',
    ONE_SHOT_EXAMPLE,
  ].filter(Boolean).join('\n');
}

function buildUserPrompt(prompt, mode, durationSec, channelHint, isShorts) {
  const sceneCount = Math.max(3, Math.round(durationSec / mode.pacing.avgSceneSeconds));
  const wantsNarration = mode.voice !== null;
  const channelBlock = channelHint
    ? `\n\nThe user's channel patterns:\n${channelHint}\nMatch this style where you can.`
    : '';
  const shortsBlock = isShorts
    ? `\n\nFORMAT: This is a YouTube Short — vertical 9:16, ${durationSec}s max. Scene 1 narration MUST hook in the first 3 seconds (curiosity gap, surprising fact, or unanswered question). Sentences are short and conversational. search_query should describe close-up / single-subject / portrait-oriented visuals.`
    : '';
  const narrationBlock = wantsNarration
    ? `Each scene MUST include a "narration" field with one short, factual sentence (8-22 words). Reference specific named entities.`
    : `This mode has NO narration — set "narration" to "" for every scene. Use the "title_overlay" field instead (2-4 words).`;

  return `Topic: ${prompt}
Mode: ${mode.name}
Total duration: ${durationSec} seconds
Number of scenes: ~${sceneCount}
Per-scene duration: ~${mode.pacing.avgSceneSeconds}s${channelBlock}${shortsBlock}

${narrationBlock}

Output STRICT JSON: { "title", "description", "tags", "scenes": [...] }`;
}

async function callPollinationsOnce(model, systemPrompt, userPrompt) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    seed: Math.floor(Math.random() * 1e9),
  };
  const r = await fetch(POLLINATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`pollinations http ${r.status}`);
  const j = await r.json();
  const msg = j?.choices?.[0]?.message;
  const content = msg?.content;
  if (!content || !content.trim()) {
    const hint = msg?.reasoning ? 'thinking-only reply' : 'empty content';
    throw new Error('pollinations ' + hint);
  }
  return content;
}

async function callPollinationsRetry(model, systemPrompt, userPrompt, attempts) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Promise.race([
        callPollinationsOnce(model, systemPrompt, userPrompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), 45000)),
      ]);
    } catch (e) {
      lastErr = e;
      log.warn(`Pollinations [${model}] attempt ${i} failed:`, e.message);
      if (i < attempts) await new Promise(r => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

// ---------- JSON parsing ----------

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  for (const c of findBalancedObjects(stripped).sort((a, b) => b.length - a.length)) {
    try { return JSON.parse(c); } catch (_) {}
  }
  // Last resort: the LLM's response was truncated mid-stream (a common
  // Pollinations failure for longer responses). Salvage the complete
  // scene objects from the unterminated string.
  return recoverTruncated(stripped);
}

// Recover a partial { "title": ..., "scenes": [ {...}, {...}, ... PARTIAL ] }
// response by extracting the metadata fields + only the complete scene objects
// inside the scenes array.
function recoverTruncated(text) {
  const m = text.match(/^\s*\{\s*/);
  if (!m) return null;
  // Find the start of "scenes": [
  const sceneArrayStart = text.search(/"scenes"\s*:\s*\[/);
  if (sceneArrayStart < 0) return null;
  const arrOpen = text.indexOf('[', sceneArrayStart);
  if (arrOpen < 0) return null;
  const scenes = findBalancedObjects(text.slice(arrOpen));
  if (scenes.length === 0) return null;
  // Try to extract title/description/tags before the scenes array
  const head = text.slice(0, sceneArrayStart);
  const titleMatch = head.match(/"title"\s*:\s*"([^"]+)"/);
  const descMatch = head.match(/"description"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  const tagsMatch = head.match(/"tags"\s*:\s*\[([^\]]*)\]/);
  const recovered = {
    title: titleMatch?.[1] || '',
    description: descMatch?.[1] || '',
    tags: tagsMatch ? (tagsMatch[1].match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, '')) : [],
    scenes: [],
  };
  for (const s of scenes) {
    try { recovered.scenes.push(JSON.parse(s)); } catch (_) {}
  }
  return recovered.scenes.length > 0 ? recovered : null;
}

function findBalancedObjects(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(s.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

// ---------- Deterministic fallback ----------

const STOP_WORDS = new Set(['top', 'best', 'most', 'the', 'and', 'a', 'an', 'of', 'in', 'on', 'for', 'with', 'how', 'what', 'why', 'this', 'that', 'will', 'are', 'is']);

function detectListIntent(prompt) {
  const m = prompt.match(/\btop\s+(\d+)\b/i) || prompt.match(/\b(\d+)\s+(?:best|secrets|reasons|moments|things|ways)\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function keyTerms(prompt) {
  return prompt.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function deterministicFallback(prompt, modeId, durationSec) {
  const mode = getMode(modeId);
  const listN = detectListIntent(prompt);
  const targetCount = listN || Math.max(3, Math.round(durationSec / mode.pacing.avgSceneSeconds));
  const sceneCount = Math.min(targetCount, 30);
  const per = Math.max(3, Math.round(durationSec / sceneCount));
  const terms = keyTerms(prompt);
  const cleanPrompt = prompt.trim().replace(/\.+$/, '');

  const scenes = [];
  for (let i = 0; i < sceneCount; i++) {
    const isFirst = i === 0;
    const isLast = i === sceneCount - 1;
    const term = terms[i % terms.length] || cleanPrompt;
    let narration = '';
    let label = '';

    if (mode.voice) {
      if (isFirst) narration = `Today we look at ${cleanPrompt}.`;
      else if (isLast) narration = `That was ${cleanPrompt}. If you enjoyed, hit subscribe.`;
      else if (listN) narration = `Number ${listN - i + 1}: ${term} is one of the most striking things to see in ${cleanPrompt}.`;
      else narration = `When you look at ${cleanPrompt}, ${term} stands out.`;
    }
    if (mode.bigText) {
      if (isFirst) label = 'Intro';
      else if (isLast) label = 'Outro';
      else if (listN) label = `#${listN - i + 1}`;
      else label = term.charAt(0).toUpperCase() + term.slice(1);
    }
    const visualMods = ['close up', 'wide shot', 'underwater', 'aerial', 'slow motion', 'macro', '', '', ''];
    const mod = visualMods[i % visualMods.length];
    const search = mod ? `${term} ${mod}`.trim() : (term || cleanPrompt);
    scenes.push({ narration, title_overlay: label, search_query: search, duration_seconds: per });
  }
  return {
    title: cleanPrompt.slice(0, 70),
    description: `${cleanPrompt}\n\nGenerated with Spool.`,
    tags: terms.slice(0, 10),
    scenes,
    _fallback: true,
  };
}

// ---------- Main entry point ----------

async function tryModelOnce(model, mode, prompt, userPrompt, strict) {
  const systemPrompt = buildSystemPrompt(mode.systemPrompt, strict);
  const raw = await callPollinationsRetry(model, systemPrompt, userPrompt, 3);
  appendScriptLog({ phase: 'response', model, strict, raw_head: raw.slice(0, 400), raw_tail: raw.slice(-200), length: raw.length });
  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    appendScriptLog({ phase: 'parse_fail', model, strict });
    throw new Error('unparseable');
  }
  const validationErr = validateScript(parsed, prompt);
  if (validationErr) {
    appendScriptLog({ phase: 'validation_fail', model, strict, error: validationErr });
    const e = new Error('VALIDATION:' + validationErr);
    e.parsed = parsed;
    throw e;
  }
  return parsed;
}

async function writeScript({ prompt, modeId, durationSec, channelHint, isShorts }) {
  const mode = getMode(modeId);
  const userPrompt = buildUserPrompt(prompt, mode, durationSec, channelHint, !!isShorts);
  appendScriptLog({ phase: 'request', prompt, modeId, durationSec, isShorts: !!isShorts });

  // Try each model with strict=false first, then strict=true on validation failure
  for (const model of MODEL_CHAIN) {
    for (const strict of [false, true]) {
      try {
        const parsed = await tryModelOnce(model, mode, prompt, userPrompt, strict);
        // Ensure fields exist with sensible defaults
        parsed.scenes = parsed.scenes.map((s) => ({
          narration: typeof s.narration === 'string' ? s.narration : '',
          title_overlay: typeof s.title_overlay === 'string' ? s.title_overlay : '',
          search_query: typeof s.search_query === 'string' && s.search_query.trim() ? s.search_query : prompt,
          duration_seconds: Number.isFinite(s.duration_seconds) ? s.duration_seconds : mode.pacing.avgSceneSeconds,
        }));
        if (!parsed.title) parsed.title = prompt.slice(0, 70);
        if (!parsed.description) parsed.description = prompt;
        if (!Array.isArray(parsed.tags)) parsed.tags = [];
        appendScriptLog({ phase: 'success', model, strict, sceneCount: parsed.scenes.length });
        return parsed;
      } catch (e) {
        log.warn(`writeScript [${model}, strict=${strict}] failed:`, e.message);
        // On validation fail with strict=true, still continue to next model
        continue;
      }
    }
  }

  // All LLM paths failed → deterministic fallback (no placeholders, but generic).
  appendScriptLog({ phase: 'all_models_failed', modeId, prompt });
  log.error('All LLM paths failed — using deterministic fallback');
  return deterministicFallback(prompt, modeId, durationSec);
}

module.exports = { writeScript, setLogPath };
