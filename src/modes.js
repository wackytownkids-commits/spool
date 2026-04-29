// Mode presets — each drives script style, pacing, music vibe, default duration.
// Pro flag gates premium modes behind license.

const MODES = {
  topx: {
    id: 'topx',
    name: 'Top X List',
    tagline: 'Countdown energy. Fast cuts.',
    pro: false,
    defaultDuration: 60,
    pacing: { avgSceneSeconds: 5, transition: 'cut' },
    music: { vibe: 'energetic', volumeDb: -16 },
    voice: { rate: '+10%', pitch: '+0Hz' },
    bigText: true,
    systemPrompt: `You are a viral YouTube scriptwriter. Write a "Top {N}" list video script.
Format: hooky cold-open (1 sentence), then count DOWN from N to 1. Each entry is 1-2 punchy sentences.
End with a one-line CTA ("if you enjoyed, subscribe").
Use simple sentences. No filler. No "in this video we'll explore". Get to it.`,
  },
  storyteller: {
    id: 'storyteller',
    name: 'Storyteller',
    tagline: 'Narrative arc. Cinematic feel.',
    pro: false,
    defaultDuration: 180,
    pacing: { avgSceneSeconds: 8, transition: 'fade' },
    music: { vibe: 'cinematic', volumeDb: -18 },
    voice: { rate: '-5%', pitch: '+0Hz' },
    bigText: false,
    systemPrompt: `You are a storyteller writing a short narrated video.
Use a clear arc: setup, tension, resolution. Vivid sensory language but plain words.
Pace it for narration — short sentences, natural pauses.`,
  },
  educational: {
    id: 'educational',
    name: 'Educational',
    tagline: 'Explainer with overlays.',
    pro: false,
    defaultDuration: 180,
    pacing: { avgSceneSeconds: 7, transition: 'cut' },
    music: { vibe: 'upbeat', volumeDb: -20 },
    voice: { rate: '+0%', pitch: '+0Hz' },
    bigText: true,
    systemPrompt: `You are an educational YouTuber explaining the topic clearly.
Structure: hook, 3-5 key points, brief recap. Use concrete examples. Short sentences.
Include short labels (3-6 words) per scene that could appear as a text overlay.`,
  },
  hype: {
    id: 'hype',
    name: 'Hype Montage',
    tagline: 'Music only. Beat-cut. Big titles.',
    pro: true,
    defaultDuration: 60,
    pacing: { avgSceneSeconds: 3, transition: 'cut' },
    music: { vibe: 'hype', volumeDb: -8 },
    voice: null,
    bigText: true,
    systemPrompt: `You are a sports-highlight-style editor. NO narration. Output big-text titles
(2-4 words each) that punch on the beat. Each scene is a search query for high-energy stock footage.`,
  },
  documentary: {
    id: 'documentary',
    name: 'Documentary',
    tagline: 'Slow. Contemplative.',
    pro: true,
    defaultDuration: 300,
    pacing: { avgSceneSeconds: 12, transition: 'fade' },
    music: { vibe: 'ambient', volumeDb: -22 },
    voice: { rate: '-10%', pitch: '-2Hz' },
    bigText: false,
    systemPrompt: `You are a documentary narrator. Calm, measured, descriptive prose.
Long pauses between thoughts. Each scene paints a picture. Avoid hype.`,
  },
  news: {
    id: 'news',
    name: 'News Recap',
    tagline: 'Headline graphics. Anchor cadence.',
    pro: true,
    defaultDuration: 120,
    pacing: { avgSceneSeconds: 6, transition: 'cut' },
    music: { vibe: 'news', volumeDb: -22 },
    voice: { rate: '+0%', pitch: '+0Hz' },
    bigText: true,
    systemPrompt: `You are a news anchor scripting a recap segment. Lead with the headline,
then 3-4 supporting facts, then a forward-looking close. Each scene needs a short headline (4-8 words).`,
  },
  compilation: {
    id: 'compilation',
    name: 'Compilation',
    tagline: 'Themed clips. Music only.',
    pro: false,
    defaultDuration: 90,
    pacing: { avgSceneSeconds: 5, transition: 'cut' },
    music: { vibe: 'mellow', volumeDb: -10 },
    voice: null,
    bigText: false,
    systemPrompt: `You are curating a themed clip compilation. NO narration. For each scene,
write only a short stock-footage search query (3-6 words) that fits the theme.`,
  },
  shorts: {
    id: 'shorts',
    name: 'Shorts Hook',
    tagline: 'Vertical. Hook in 3 seconds.',
    pro: true,
    defaultDuration: 30,
    forceShorts: true,
    pacing: { avgSceneSeconds: 5, transition: 'cut' },
    music: { vibe: 'hype', volumeDb: -10 },
    voice: { rate: '+8%', pitch: '+0Hz' },
    bigText: true,
    burnSubsDefault: true,
    systemPrompt: `You write punchy YouTube Shorts scripts (vertical 9:16, ~30 seconds).
Format rules — non-negotiable:
- Scene 1 narration MUST hook in the first 3 seconds. Use a curiosity gap, a surprising
  fact, or a question the viewer needs to know the answer to. No "today we'll be looking at."
- Each scene narration is ONE short sentence. Punchy. Conversational. High energy.
- Pace fast: 5-6 scenes total at most.
- Last scene narration delivers a satisfying payoff that closes the curiosity loop.
- Each scene also gets a 2-4 word title_overlay that punches at the cut.
- search_query describes a vertical-friendly visual (close-ups, faces, single subjects).`,
  },
};

const ALL_MODES = Object.values(MODES);

function isProMode(id) {
  return MODES[id]?.pro === true;
}

function getMode(id) {
  return MODES[id] || MODES.topx;
}

module.exports = { MODES, ALL_MODES, getMode, isProMode };
