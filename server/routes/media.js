import express from 'express';
import fs from 'fs';
import path from 'path';
import { mediaDB, playbackDB } from '../db/database.js';
import { scanAndIndexBucket, getScanStatus } from '../services/scanner.js';
import { enrichMediaMetadata } from '../services/aiTagger.js';
import { getOrGenerateThumbnail, getOrProbeDuration } from '../services/transcoder.js';
import { requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

const DEFAULT_SVG_THUMB = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1e24"/>
      <stop offset="100%" stop-color="#0f0f11"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  <circle cx="320" cy="180" r="44" fill="#e50914" opacity="0.9"/>
  <polygon points="312,162 336,180 312,198" fill="#ffffff"/>
  <text x="320" y="260" font-family="Roboto, sans-serif" font-size="16" fill="#808080" text-anchor="middle" font-weight="bold">KODIMI STREAM</text>
</svg>`;

function sendFallbackThumbnail(res) {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).send(DEFAULT_SVG_THUMB);
}

function isVaultAuthorized(req) {
  const pin = req.headers['x-vault-pin'] || req.query.pin;
  return req.user?.vault === true || (pin && pin.toString().trim() === config.privatePin.toString().trim());
}

// Public/Auth protected media listing
router.get('/', requireAuth, (req, res) => {
  const { type, genre, search, limit, offset, adult, is_adult } = req.query;
  const showAdult = adult === 'true' || is_adult === 'true';

  if (showAdult) {
    if (!isVaultAuthorized(req)) {
      return res.status(403).json({ error: 'Vault PIN required to access private media', vaultRequired: true });
    }

    const items = mediaDB.getAll({
      type,
      genre,
      search,
      limit: limit ? parseInt(limit, 10) : 500,
      offset: offset ? parseInt(offset, 10) : 0,
      isAdult: true,
    });

    return res.json({ items });
  }

  const items = mediaDB.getAll({
    type,
    genre,
    search,
    limit: limit ? parseInt(limit, 10) : 500,
    offset: offset ? parseInt(offset, 10) : 0,
    isAdult: false,
  });

  res.json({ items });
});

router.get('/genres', requireAuth, (req, res) => {
  const genres = mediaDB.getAllGenres();
  res.json({ genres });
});

router.get('/continue-watching', requireAuth, (req, res) => {
  const allowAdult = isVaultAuthorized(req);
  const items = playbackDB.getContinueWatching(15, allowAdult);
  res.json({ items });
});

// Grouped TV Series catalog
router.get('/series', requireAuth, (req, res) => {
  const { search, limit, adult, is_adult } = req.query;
  const showAdult = adult === 'true' || is_adult === 'true';

  if (showAdult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required to access private series', vaultRequired: true });
  }

  const items = mediaDB.getSeriesGrouped({
    search,
    limit: limit ? parseInt(limit, 10) : 100,
    isAdult: showAdult,
  });

  res.json({ items });
});

// Get all seasons and episodes for a series
router.get('/series/:name/seasons', requireAuth, (req, res) => {
  const { adult, is_adult } = req.query;
  const showAdult = adult === 'true' || is_adult === 'true';

  if (showAdult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required to access private series', vaultRequired: true });
  }

  const seriesName = decodeURIComponent(req.params.name);
  const data = mediaDB.getSeriesSeasons(seriesName, showAdult);
  res.json(data);
});

router.get('/sync-status', requireAuth, (req, res) => {
  res.json(getScanStatus());
});

router.post('/sync-bucket', requireAuth, (req, res) => {
  // Run scan in background
  scanAndIndexBucket();
  res.json({ message: 'Bucket scan initiated in background', status: getScanStatus() });
});

router.get('/:id/thumbnail', async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return sendFallbackThumbnail(res);
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required');
  }

  try {
    const variant = req.query.variant || 'random';
    const thumbPath = await getOrGenerateThumbnail(item.id, item.gcs_path, variant);
    if (!thumbPath || !fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) {
      return sendFallbackThumbnail(res);
    }

    const ext = path.extname(thumbPath).toLowerCase();
    const isSvg = ext === '.svg';
    const contentType = isSvg ? 'image/svg+xml' : 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    if (isSvg) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
    res.sendFile(path.resolve(thumbPath), (err) => {
      if (err && !res.headersSent) {
        sendFallbackThumbnail(res);
      }
    });
  } catch (err) {
    sendFallbackThumbnail(res);
  }
});

router.get('/:id/duration', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required' });
  }

  try {
    const duration = await getOrProbeDuration(item.id, item.gcs_path);
    res.json({ duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required to access private media', vaultRequired: true });
  }

  // Trigger background duration probing if missing
  if (!item.duration || item.duration <= 0) {
    getOrProbeDuration(item.id, item.gcs_path).catch(() => {});
  }

  const progress = playbackDB.getProgress(item.id);
  res.json({ item, progress });
});

router.post('/:id/retag', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  try {
    const updatedMeta = await enrichMediaMetadata(item.filename, item.size_bytes);
    const updated = mediaDB.upsert({
      ...updatedMeta,
      id: item.id,
      gcs_path: item.gcs_path,
    });
    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/vault-toggle', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  const { is_adult } = req.body;
  const newAdultState = typeof is_adult === 'boolean' ? is_adult : !item.is_adult;

  const updated = await mediaDB.upsert({
    ...item,
    is_adult: newAdultState,
  });

  console.log(`[Vault Toggle] Moved "${item.title}" to ${newAdultState ? 'Private Vault' : 'Public Library'}`);
  res.json({ success: true, item: updated, is_adult: newAdultState });
});

router.delete('/:id', requireAuth, (req, res) => {
  mediaDB.delete(req.params.id);
  res.json({ success: true });
});

router.post('/playback/progress', requireAuth, (req, res) => {
  const { mediaId, currentTime, duration, completed } = req.body;
  if (!mediaId) {
    return res.status(400).json({ error: 'mediaId is required' });
  }

  playbackDB.saveProgress(mediaId, currentTime, duration, completed);
  res.json({ success: true });
});

export default router;
