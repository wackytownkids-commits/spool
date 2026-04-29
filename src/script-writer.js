// Script writer — calls Pollinations.ai (free, no key) to generate a structured
// script JSON for the requested mode + duration. Falls back to a deterministic
// template if the LLM call fails.

const fetch = require('node-fetch');
const log = require('electron-log');
const { getMode } = require('./modes');

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const POLLINATIONS_FALLBACK = 'https://text.pollinations.ai/';

function buildUserPrompt(prompt, mode, durationSec, channelHint) {
  const sceneCount = Math.max(3, Math.round(durationSec / mode.pacing.avgSceneSeconds));
  const wantsNarration = mode.voice !== null;

  const channelBlock = channelHint
    ? `\n\nThe user's channel patterns:\n${channelHint}\nMatch this style where you can.`
    : '';

  const narrationBlock = wantsNarration
    ? `Each scene MUST include a "narration" field with 1-3 sentences that fit a ${mode.pacing.avgSceneSeconds}-second clip.`
    : `This mode has NO narration — set "narration" to "" for every scene. Use the "title_overlay" field instead (2-4 words).`;

  return `Topic: ${prompt}
Mode: ${mode.name}
Total duration: ${durationSec} seconds
Number of scenes: ~${sceneCount}
Per-scene duration: ~${mode.pacing.avgSceneSeconds}s${channelBlock}

${narrationBlock}

Output STRICT JSON with this shape (no markdown fence, no commentary):
{
  "title": "...",        // YouTube title, <= 70 chars, hooky
  "description": "...",  // 2-3 sentence YouTube description
  "tags": ["..."],       // 8-15 lowercase tags
  "scenes": [
    {
      "narration": "...",
      "title_overlay": "...",  // optional 2-4 word on-screen text
      "search_query": "...",   // 2-5 word stock-footage query for Pexels/Pixabay
      "duration_seconds": ${mode.pacing.avgSceneSeconds}
    }
  ]
}

Scenes total duration must sum to roughly ${durationSec} seconds.
Search queries should describe VISUALS, not concepts (e.g. "city traffic at night", not "urban life").`;
}

async function callPollinationsOpenAIOnce(systemPrompt, userPrompt) {
  // NOTE: do NOT set response_format: json_object — Pollinations' OpenAI-compat
  // shim is buggy with that flag (emits a stray '{"' prefix).
  const body = {
    model: 'openai',
    messages: [
      { role: 'system', content: systemPrompt + '\n\nReturn ONLY raw JSON. No markdown fence. No commentary. Start your response with { and end with }.' },
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
  // Pollinations occasionally returns a "thinking" response with `reasoning`
  // populated and `content` empty. Treat that as a transient failure; the
  // caller will retry with a fresh seed.
  const msg = j?.choices?.[0]?.message;
  const content = msg?.content;
  if (!content || !content.trim()) {
    const hint = msg?.reasoning ? 'thinking-only reply' : 'empty content';
    throw new Error('pollinations ' + hint);
  }
  return content;
}

async function callPollinationsOpenAI(systemPrompt, userPrompt) {
  // Retry up to 3 attempts. The "empty content" failure is transient and
  // usually resolves on the next call (different seed → different model path).
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await Promise.race([
        callPollinationsOpenAIOnce(systemPrompt, userPrompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), 45000)),
      ]);
    } catch (e) {
      lastErr = e;
      log.warn(`Pollinations attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

function parseJsonLoose(text) {
  if (!text) return null;
  // 1. Direct
  try { return JSON.parse(text); } catch (_) {}
  // 2. Strip code fences
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // 3. Find balanced {...} blocks and try each from largest to smallest
  const candidates = findBalancedObjects(stripped);
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) {}
  }
  return null;
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

// Words that carry meaning vs filler. Used to make fallback search queries
// less repetitive than just sending the full prompt every time.
const STOP_WORDS = new Set(['top', 'best', 'most', 'the', 'and', 'a', 'an', 'of', 'in', 'on', 'for', 'with', 'how', 'what', 'why', 'this', 'that', 'will', 'are', 'is']);

function detectListIntent(prompt) {
  const m = prompt.match(/\btop\s+(\d+)\b/i) || prompt.match(/\b(\d+)\s+(?:best|secrets|reasons|moments|things|ways)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function keyTerms(prompt) {
  return prompt.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

// Build narration that's at least topically relevant when the LLM is down.
// Better than "Top X — moment 1": uses the prompt verbatim with framing
// language, distributes key terms across scenes for variety, and mirrors
// the requested list intent if detected.
function deterministicFallback(prompt, modeId, durationSec) {
  const mode = getMode(modeId);
  const listN = detectListIntent(prompt);
  const targetCount = listN || Math.max(3, Math.round(durationSec / mode.pacing.avgSceneSeconds));
  const sceneCount = Math.min(targetCount, 30);
  const per = Math.max(3, Math.round(durationSec / sceneCount));
  const terms = keyTerms(prompt);
  const cleanPrompt = prompt.trim().replace(/\.+$/, '');

  const introLines = [
    `Today we look at ${cleanPrompt}.`,
    `Let's explore ${cleanPrompt}.`,
  ];
  const outroLines = [
    `That was ${cleanPrompt}. If you enjoyed, hit subscribe.`,
    `Thanks for watching — there's more like this on the way.`,
  ];

  const scenes = [];
  for (let i = 0; i < sceneCount; i++) {
    const isFirst = i === 0;
    const isLast = i === sceneCount - 1;
    const term = terms[i % terms.length] || cleanPrompt;
    let narration = '';
    let label = '';

    if (mode.voice) {
      if (isFirst) narration = introLines[0];
      else if (isLast) narration = outroLines[0];
      else if (listN) narration = `Number ${listN - i + 1}: ${term} is one of the most striking things to see in ${cleanPrompt}.`;
      else narration = `When you look at ${cleanPrompt}, ${term} stands out.`;
    }

    if (mode.bigText) {
      if (isFirst) label = 'Intro';
      else if (isLast) label = 'Outro';
      else if (listN) label = `#${listN - i + 1}`;
      else label = term.charAt(0).toUpperCase() + term.slice(1);
    }

    // Search query: combine prompt key term + 1-2 visual modifiers per scene
    const visualMods = ['close up', 'wide shot', 'underwater', 'aerial', 'slow motion', 'macro', '', '', ''];
    const mod = visualMods[i % visualMods.length];
    const search = mod ? `${term} ${mod}`.trim() : (term || cleanPrompt);

    scenes.push({
      narration,
      title_overlay: label,
      search_query: search,
      duration_seconds: per,
    });
  }
  return {
    title: cleanPrompt.slice(0, 70),
    description: `${cleanPrompt}\n\nGenerated with Spool.`,
    tags: terms.slice(0, 10),
    scenes,
    _fallback: true,
  };
}

async function writeScript({ prompt, modeId, durationSec, channelHint }) {
  const mode = getMode(modeId);
  const userPrompt = buildUserPrompt(prompt, mode, durationSec, channelHint);

  let raw;
  try {
    raw = await callPollinationsOpenAI(mode.systemPrompt, userPrompt);
  } catch (e) {
    log.error('LLM unreachable after 3 attempts, using deterministic fallback:', e.message);
    return deterministicFallback(prompt, modeId, durationSec);
  }

  let parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    // Try ONE more LLM call before giving up — a fresh seed often recovers
    // from a borderline-malformed response.
    log.warn('LLM returned unparseable JSON, retrying once. Raw head:', String(raw).slice(0, 200));
    try {
      raw = await callPollinationsOpenAI(mode.systemPrompt, userPrompt);
      parsed = parseJsonLoose(raw);
    } catch (_) {}
  }
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    log.error('LLM JSON unparseable after retry, using deterministic fallback');
    return deterministicFallback(prompt, modeId, durationSec);
  }
  // Sanity-check scenes have required fields
  parsed.scenes = parsed.scenes.map((s, i) => ({
    narration: typeof s.narration === 'string' ? s.narration : '',
    title_overlay: typeof s.title_overlay === 'string' ? s.title_overlay : '',
    search_query: typeof s.search_query === 'string' && s.search_query.trim() ? s.search_query : prompt,
    duration_seconds: Number.isFinite(s.duration_seconds) ? s.duration_seconds : mode.pacing.avgSceneSeconds,
  }));
  if (!parsed.title) parsed.title = prompt.slice(0, 70);
  if (!parsed.description) parsed.description = prompt;
  if (!Array.isArray(parsed.tags)) parsed.tags = [];
  return parsed;
}

module.exports = { writeScript };
