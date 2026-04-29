// YouTube Data API v3 wrappers — upload, set thumbnail, list channel info,
// pull recent uploads for "channel learning."

const fs = require('fs');
const { google } = require('googleapis');
const log = require('electron-log');

function ytClient(authClient) {
  return google.youtube({ version: 'v3', auth: authClient });
}

async function getChannel(authClient) {
  const yt = ytClient(authClient);
  const r = await yt.channels.list({ part: ['snippet', 'statistics', 'contentDetails'], mine: true });
  return r.data.items?.[0] || null;
}

async function getRecentVideos(authClient, max = 50) {
  const yt = ytClient(authClient);
  const ch = await getChannel(authClient);
  if (!ch) return [];
  const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];
  const items = [];
  let pageToken;
  while (items.length < max) {
    const r = await yt.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId: uploadsId,
      maxResults: Math.min(50, max - items.length),
      pageToken,
    });
    items.push(...(r.data.items || []));
    if (!r.data.nextPageToken) break;
    pageToken = r.data.nextPageToken;
  }
  return items;
}

// Lightweight stats over recent uploads — used by "channel learning" feature.
function analyzeChannelVideos(videos) {
  if (!videos || videos.length === 0) return null;
  const titles = videos.map(v => v.snippet?.title).filter(Boolean);
  const titleAvgLen = Math.round(titles.reduce((a, t) => a + t.length, 0) / titles.length);
  const questionRate = titles.filter(t => t.includes('?')).length / titles.length;
  const numberRate = titles.filter(t => /\d/.test(t)).length / titles.length;
  const allCapsRate = titles.filter(t => /\b[A-Z]{3,}\b/.test(t)).length / titles.length;

  const dates = videos.map(v => new Date(v.contentDetails?.videoPublishedAt || v.snippet?.publishedAt)).filter(d => !isNaN(d));
  let cadenceDays = null;
  if (dates.length >= 3) {
    dates.sort((a, b) => b - a);
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i - 1] - dates[i]) / (1000 * 60 * 60 * 24));
    }
    cadenceDays = Math.round(gaps.reduce((a, x) => a + x, 0) / gaps.length);
  }

  return {
    sampleSize: titles.length,
    titleAvgLen,
    questionRate: Math.round(questionRate * 100),
    numberRate: Math.round(numberRate * 100),
    allCapsRate: Math.round(allCapsRate * 100),
    cadenceDays,
    sampleTitles: titles.slice(0, 8),
  };
}

function analysisToHint(a) {
  if (!a) return '';
  const bits = [];
  bits.push(`Average title length: ${a.titleAvgLen} characters.`);
  if (a.numberRate > 30) bits.push(`Titles often include numbers (${a.numberRate}%).`);
  if (a.questionRate > 30) bits.push(`Titles often phrased as questions (${a.questionRate}%).`);
  if (a.allCapsRate > 30) bits.push(`Frequently uses ALL-CAPS emphasis.`);
  if (a.cadenceDays != null) bits.push(`Posts roughly every ${a.cadenceDays} days.`);
  if (a.sampleTitles?.length) bits.push(`Recent titles for tone reference:\n- ${a.sampleTitles.slice(0, 5).join('\n- ')}`);
  return bits.join(' ');
}

async function uploadVideo(authClient, {
  videoPath,
  thumbPath,
  title,
  description,
  tags,
  privacyStatus = 'private',
  publishAt = null,           // RFC3339, requires privacyStatus='private'
  categoryId = '22',          // People & Blogs
  onProgress,
}) {
  const yt = ytClient(authClient);
  const status = { privacyStatus, selfDeclaredMadeForKids: false };
  if (publishAt) status.publishAt = publishAt;

  const fileSize = fs.statSync(videoPath).size;
  let lastReported = 0;

  const res = await yt.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: true,
      requestBody: {
        snippet: { title, description, tags, categoryId },
        status,
      },
      media: { body: fs.createReadStream(videoPath) },
    },
    {
      onUploadProgress: (e) => {
        if (!onProgress) return;
        const pct = e.bytesRead / fileSize;
        if (pct - lastReported >= 0.01 || pct === 1) {
          lastReported = pct;
          onProgress({ stage: 'upload:video', pct, bytes: e.bytesRead, total: fileSize });
        }
      },
    }
  );

  const videoId = res.data?.id;
  if (!videoId) throw new Error('Upload returned no videoId');

  // Set thumbnail (best-effort)
  if (thumbPath && fs.existsSync(thumbPath)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(thumbPath) },
      });
      onProgress?.({ stage: 'upload:thumbnail', pct: 1 });
    } catch (e) {
      log.warn('Thumbnail set failed (channel may need verification):', e.message);
    }
  }

  return { videoId, url: `https://youtu.be/${videoId}` };
}

module.exports = { getChannel, getRecentVideos, analyzeChannelVideos, analysisToHint, uploadVideo };
