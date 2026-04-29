// Prompt fan-out — given a seed topic, ask the LLM for N distinct video prompts
// derived from it. Used by Auto-Batch and Slipstream.

const fetch = require('node-fetch');
const log = require('electron-log');

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';

const FANOUT_SYSTEM = `You generate distinct, specific video ideas for a YouTube creator.
Given a seed topic, output a JSON array of {count} concrete video prompts. Each prompt must be:
- A different angle on the seed (no near-duplicates)
- Visual / search-friendly (something stock footage could match)
- 4-12 words, like a YouTube title without the clickbait

Return ONLY raw JSON. No markdown fence. No commentary. Start with [ and end with ].`;

const SLIPSTREAM_SYSTEM = `You generate ORIGINAL video ideas inspired by — but not copying — another creator's video.
Given a source title, output ONE concrete video prompt that explores the same topic from a different angle.
Visual / search-friendly. 4-12 words. Do NOT paraphrase the source title or copy its structure.

Return ONLY the prompt as a plain string. No quotes, no JSON, no markdown.`;

function findBalancedArrays(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
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
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { out.push(s.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

function parseArrayLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  for (const c of findBalancedArrays(stripped).sort((a, b) => b.length - a.length)) {
    try { return JSON.parse(c); } catch (_) {}
  }
  return null;
}

async function callLLM(system, user, timeoutMs = 60000) {
  const body = {
    model: 'openai',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    seed: Math.floor(Math.random() * 1e9),
  };
  const r = await Promise.race([
    fetch(POLLINATIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), timeoutMs)),
  ]);
  if (!r.ok) throw new Error(`pollinations http ${r.status}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || '';
}

async function fanoutPrompts(seed, count) {
  const sys = FANOUT_SYSTEM.replace('{count}', String(count));
  const user = `Seed topic: ${seed}\nCount: ${count}`;
  let raw;
  try {
    raw = await callLLM(sys, user);
  } catch (e) {
    log.warn('fanout LLM failed:', e.message);
    return deterministicFanout(seed, count);
  }
  const parsed = parseArrayLoose(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    log.warn('fanout returned bad JSON, using fallback');
    return deterministicFanout(seed, count);
  }
  // Normalize to strings, dedupe, trim to count
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    const s = (typeof item === 'string' ? item : (item?.prompt || item?.title || '')).trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= count) break;
  }
  if (out.length === 0) return deterministicFanout(seed, count);
  // Pad with deterministic if LLM gave fewer than requested
  while (out.length < count) {
    out.push(`${seed} — angle ${out.length + 1}`);
  }
  return out;
}

function deterministicFanout(seed, count) {
  const angles = [
    'biggest moments', 'rare footage', 'beginner guide', 'common mistakes',
    'wild reactions', 'behind the scenes', 'top compilation', 'what nobody tells you',
    'visual breakdown', 'quick recap', 'unexpected angle', 'reality check',
    'hidden details', 'fan favorites', 'the deep dive', 'first 60 seconds',
    'iconic moments', 'rookie tips', 'science behind', 'in 30 seconds',
    'biggest myths', 'expert take', 'speed run', 'history of',
    'side-by-side', 'unsung details', 'shocking truth', 'every angle',
    'the hot take', 'one more thing',
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${seed} — ${angles[i % angles.length]}`);
  }
  return out;
}

async function slipstreamPrompt(sourceTitle) {
  let raw;
  try {
    raw = await callLLM(SLIPSTREAM_SYSTEM, `Source video title: ${sourceTitle}`, 45000);
  } catch (e) {
    log.warn('slipstream LLM failed:', e.message);
    return null;
  }
  // Strip wrapping quotes / fences / leading "-" bullets
  return String(raw).replace(/^[\s"'`\-*•]+|[\s"'`]+$/g, '').replace(/```/g, '').trim() || null;
}

module.exports = { fanoutPrompts, slipstreamPrompt };
