# Spool

Prompt → YouTube. Generate stock-footage videos and ship them to your channel.

Free APIs only. No billing, ever.

## What it is

Type a prompt. Pick a mode (Top X List, Storyteller, Documentary, Hype Montage, Educational, News Recap, Compilation). Pick a duration. Click Generate.

Spool writes the script (free LLM), pulls matching stock footage (Pexels + Pixabay), records the voiceover (Microsoft Edge's neural voices, free), edits it together with FFmpeg, and uploads to your YouTube channel via the official API.

## Standout features

- **Channel learning** — analyzes your last 50 uploads and tunes new scripts to match your style.
- **Auto-batch** *(Pro)* — queue up to 30 videos, schedule them across days.
- **Beat-cut mode** *(Pro, in `hype` mode)* — clip cuts snap to music beats.
- **7 modes**, each with distinct pacing, narration tone, music vibe, and editing style.
- **Loopback OAuth** for YouTube — your tokens stay on your machine.

## Free vs Pro

**Free**
- Top X List, Storyteller, Educational, Compilation
- Up to 60-second videos
- 10 voices
- Manual upload

**Pro** ($20 one-time)
- All 7 modes (Hype Montage, Documentary, News Recap)
- Up to 30 minutes
- All ~322 edge-tts voices
- Auto-batch
- Channel learning
- Scheduled uploads

## Setup

1. Install — run `Spool-Setup-X.Y.Z.exe`.
2. Connect your YouTube channel (OAuth in your browser).
3. Add free Pexels and Pixabay API keys. Both are free, both take 2 minutes.
4. Generate.

## Building from source

```
npm install
npm start         # dev
npm run dist:win  # produce installer
```

See `RELEASING.md` for the shipping flow.

## Quotas

YouTube Data API: 10,000 units/day per project, ~6 video uploads/day per Google account. Spool surfaces this in the UI when you're approaching the cap.
