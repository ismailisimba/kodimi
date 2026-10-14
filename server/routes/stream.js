import express from 'express';
import { mediaDB } from '../db/database.js';
import {
  streamOriginalDirect,
  streamOriginalRemux,
  streamTranscodedVideo,
  streamSubtitles,
  getSubtitleTracks,
  RESOLUTION_PROFILES,
} from '../services/transcoder.js';
import { requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

function isVaultAuthorized(req) {
  const pin = req.headers['x-vault-pin'] || req.query.pin;
  return req.user?.vault === true || (pin && pin.toString().trim() === config.privatePin.toString().trim());
}

/**
 * Original Resolution Streaming.
 * Default: streamOriginalRemux (-c:v copy -c:a aac) for guaranteed audio compatibility in all browsers!
 * If ?direct=true: raw HTTP 206 byte-range passthrough.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).send('Media not found');
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required to stream private media');
  }

  const startTime = parseFloat(req.query.time || '0');
  const direct = req.query.direct === 'true';

  try {
    if (direct) {
      await streamOriginalDirect(item.gcs_path, req, res);
    } else {
      await streamOriginalRemux(item.gcs_path, startTime, req, res);
    }
  } catch (err) {
    console.error(`[Stream Error - ${item.title}]:`, err.message);
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

/**
 * On-Demand FFMPEG Downscaling (144p, 240p, 360p, 480p, 720p, 1080p).
 * Query params: ?quality=360p&time=0
 */
router.get('/:id/transcode', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).send('Media not found');
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required to stream private media');
  }

  const quality = req.query.quality || '360p';
  const startTime = parseFloat(req.query.time || '0');

  if (quality === 'original') {
    return streamOriginalRemux(item.gcs_path, startTime, req, res);
  }

  if (!RESOLUTION_PROFILES[quality]) {
    return res.status(400).send(`Invalid quality profile. Available: ${Object.keys(RESOLUTION_PROFILES).join(', ')}`);
  }

  try {
    await streamTranscodedVideo(item.gcs_path, quality, startTime, req, res);
  } catch (err) {
    console.error(`[Transcode Stream Error]:`, err.message);
    if (!res.headersSent) res.status(500).send('Transcoding error');
  }
});

/**
 * Subtitles Endpoint (WebVTT).
 * Query params: ?track=0
 */
router.get('/:id/subtitles', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).send('Media not found');
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required');
  }

  const trackIndex = parseInt(req.query.track || '0', 10);
  await streamSubtitles(item.gcs_path, trackIndex, req, res);
});

/**
 * Subtitle Tracks List Endpoint.
 * Returns array of available subtitle streams: [{ trackIndex, language, label }, ...]
 */
router.get('/:id/subtitles/tracks', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required' });
  }

  const tracks = await getSubtitleTracks(item.id, item.gcs_path);
  res.json({ tracks });
});

export default router;
