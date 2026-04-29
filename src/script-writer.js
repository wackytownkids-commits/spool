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

async function callPollinationsOpenAI(systemPrompt, userPrompt) {
  // NOTE: do NOT set response_format: json_object — Pollinations' OpenAI-compat
  // shim is buggy with that flag (emits a stray '{"' prefix). Plain prompt + a
  // strict system rule + our balanced-brace parser handles JSON reliably.
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
  const content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error('pollinations empty content');
  return content;
}

async function callPollinationsFallback(systemPrompt, userPrompt) {
  // GET endpoint, simpler — used as fallback if openai-compat endpoint stalls
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const url = POLLINATIONS_FALLBACK + encodeURIComponent(fullPrompt) + '?json=true';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`pollinations-fallback http ${r.status}`);
  return await r.text();
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

function deterministicFallback(prompt, modeId, durationSec) {
  const mode = getMode(modeId);
  const sceneCount = Math.max(3, Math.round(durationSec / mode.pacing.avgSceneSeconds));
  const per = Math.round(durationSec / sceneCount);
  const scenes = [];
  for (let i = 0; i < sceneCount; i++) {
    scenes.push({
      narration: mode.voice ? `${prompt} — moment ${i + 1}.` : '',
      title_overlay: mode.bigText ? `Part ${i + 1}` : '',
      search_query: prompt,
      duration_seconds: per,
    });
  }
  return {
    title: prompt.slice(0, 70),
    description: `${prompt}\n\nGenerated with Spool.`,
    tags: prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 10),
    scenes,
    _fallback: true,
  };
}

async function writeScript({ prompt, modeId, durationSec, channelHint }) {
  const mode = getMode(modeId);
  const userPrompt = buildUserPrompt(prompt, mode, durationSec, channelHint);

  let raw;
  try {
    raw = await Promise.race([
      callPollinationsOpenAI(mode.systemPrompt, userPrompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), 60000)),
    ]);
  } catch (e) {
    log.warn('Pollinations OpenAI endpoint failed, trying fallback:', e.message);
    try {
      raw = await Promise.race([
        callPollinationsFallback(mode.systemPrompt, userPrompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), 60000)),
      ]);
    } catch (e2) {
      log.error('All LLM endpoints failed, using deterministic fallback:', e2.message);
      return deterministicFallback(prompt, modeId, durationSec);
    }
  }

  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    log.warn('LLM returned unparseable JSON, using fallback. Raw:', String(raw).slice(0, 300));
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
