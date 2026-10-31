import express from 'express';
import { mediaDB } from '../db/database.js';
import {
  streamOriginalDirect,
  streamOriginalRemux,
  streamTranscodedVideo,
  streamSubtitles,
  getSubtitleTracks,
  saveCustomSubtitle,
  deleteCustomSubtitle,
  RESOLUTION_PROFILES,
} from '../services/transcoder.js';
import { requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

function isVaultAuthorized(req) {
  const pin = req.headers['x-vault-pin'] || req.query.pin;
  return req.user?.vault === true || (pin && pin.toString().trim() === config.privatePin.toString().trim());
}

function resolveSessionKey(req, mediaId) {
  if (req.query.sid) return String(req.query.sid).slice(0, 80);
  const profileId = req.headers['x-profile-id'] || req.query.profile || 'default';
  const user = req.user?.user || 'admin';
  return `${user}:${profileId}:${mediaId}`;
}

/**
 * Original Resolution Streaming.
 * Default: streamOriginalRemux (-c:v copy -c:a aac) with frame-locked A/V sync for universal audio compatibility.
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
  const sessionId = resolveSessionKey(req, item.id);

  try {
    if (direct) {
      await streamOriginalDirect(item.gcs_path, req, res);
    } else {
      await streamOriginalRemux(item.gcs_path, startTime, req, res, { item, sessionId });
    }
  } catch (err) {
    console.error(`[Stream Error - ${item.title}]:`, err.message);
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

/**
 * On-Demand FFMPEG Low-Bandwidth Streaming (144p, 240p, 360p, 480p, 720p, 1080p-low, 1080p).
 * Supports AV1 (libsvtav1), HEVC (libx265), and tuned H.264 with smart passthrough.
 * Query params: ?quality=720p&time=0&codec=av1&sid=...
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
  const codec = req.query.codec || 'h264';
  const sessionId = resolveSessionKey(req, item.id);

  if (quality === 'original') {
    return streamOriginalRemux(item.gcs_path, startTime, req, res, { item, sessionId });
  }

  if (!RESOLUTION_PROFILES[quality]) {
    return res.status(400).send(`Invalid quality profile. Available: ${Object.keys(RESOLUTION_PROFILES).join(', ')}`);
  }

  try {
    await streamTranscodedVideo(item.gcs_path, quality, startTime, req, res, {
      item,
      codec,
      sessionId,
      clientSupportsHevc: req.query.hevc === '1' || codec === 'hevc',
      clientSupportsAv1: req.query.av1 === '1' || codec === 'av1',
    });
  } catch (err) {
    console.error(`[Transcode Stream Error]:`, err.message);
    if (!res.headersSent) res.status(500).send('Transcoding error');
  }
});

/**
 * Subtitles Endpoint (WebVTT).
 * Supports embedded tracks (?track=0) and persisted custom uploaded subtitles (?customId=sub_...).
 */
router.get('/:id/subtitles', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).send('Media not found');
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required');
  }

  const customId = req.query.customId ? String(req.query.customId) : null;
  if (customId) {
    const customSub = (item.custom_subtitles || []).find((s) => s.id === customId);
    if (!customSub) {
      return res.status(404).send('Custom subtitle not found');
    }
    return streamSubtitles(item.gcs_path, 0, req, res, { mediaId: item.id, customSub });
  }

  const trackIndex = parseInt(req.query.track || '0', 10);
  await streamSubtitles(item.gcs_path, trackIndex, req, res, { mediaId: item.id });
});

/**
 * Subtitle Tracks List Endpoint.
 * Returns array of available custom + embedded subtitle streams.
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

/**
 * Upload & Persist Manual Subtitle (.srt, .vtt, .ass, .ssa) to GCS (.subtitles/) + MongoDB.
 */
router.post('/:id/subtitles/custom', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required' });
  }

  const { filename, label, language, content } = req.body || {};
  if (!content || typeof content !== 'string' || content.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Valid subtitle text content (up to 10MB) is required' });
  }

  try {
    const result = await saveCustomSubtitle(item, { filename, label, language, content });
    res.json({
      success: true,
      track: {
        id: result.track.id,
        customId: result.track.id,
        trackIndex: null,
        language: result.track.language,
        label: result.track.label,
        codec: 'webvtt',
        isCustom: true,
      },
      vtt: result.vtt,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to parse or save subtitle file' });
  }
});

/**
 * Delete a persisted custom subtitle track from GCS & MongoDB.
 */
router.delete('/:id/subtitles/custom/:subId', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required' });
  }

  const deleted = await deleteCustomSubtitle(item, req.params.subId);
  if (!deleted) {
    return res.status(404).json({ error: 'Custom subtitle not found' });
  }

  res.json({ success: true });
});

export default router;
