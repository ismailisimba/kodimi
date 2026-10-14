import express from 'express';
import { mediaDB, playbackDB } from '../db/database.js';
import { scanAndIndexBucket, getScanStatus } from '../services/scanner.js';
import { enrichMediaMetadata } from '../services/aiTagger.js';
import { getOrGenerateThumbnail } from '../services/transcoder.js';
import { requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

function isVaultAuthorized(req) {
  const pin = req.headers['x-vault-pin'] || req.query.pin;
  return req.user?.vault === true || (pin && pin.toString().trim() === config.privatePin.toString().trim());
}

// Public/Auth protected media listing
router.get('/', requireAuth, (req, res) => {
  const { type, genre, search, limit, offset, adult } = req.query;

  if (adult === 'true') {
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
  const items = playbackDB.getContinueWatching(15);
  res.json({ items });
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
    return res.status(404).send('Media not found');
  }

  if (item.is_adult && !isVaultAuthorized(req)) {
    return res.status(403).send('Vault PIN required');
  }

  try {
    const thumbPath = await getOrGenerateThumbnail(item.id, item.gcs_path);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(thumbPath);
  } catch (err) {
    res.status(404).send('Thumbnail not available');
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
