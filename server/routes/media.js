import express from 'express';
import fs from 'fs';
import path from 'path';
import { mediaDB, playbackDB, ensureMediaCacheFresh, normalizeSeriesKey } from '../db/database.js';
import { scanAndIndexBucket, syncGcsTimestampsOnly, getScanStatus } from '../services/scanner.js';
import { enrichMediaMetadata, isPlaceholderOrGenericPlot } from '../services/aiTagger.js';
import { getThumbnailRedirectUrl, getOrGenerateThumbnail, getOrProbeDuration } from '../services/transcoder.js';
import { requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

let retagBatchState = {
  inProgress: false,
  total: 0,
  processed: 0,
  updated: 0,
  timestampsSynced: 0,
};

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

function getProfileId(req) {
  return req.headers['x-profile-id'] || 'default';
}

// Public/Auth protected media listing
router.get('/', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
  const { type, genre, search, limit, offset, adult, is_adult, sort } = req.query;
  const showAdult = adult === 'true' || is_adult === 'true';

  if (showAdult) {
    if (!isVaultAuthorized(req)) {
      return res.status(403).json({ error: 'Vault PIN required to access private media', vaultRequired: true });
    }

    const items = mediaDB.getAll({
      type,
      genre,
      search,
      sort: sort || 'recent',
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
    sort: sort || 'recent',
    limit: limit ? parseInt(limit, 10) : 500,
    offset: offset ? parseInt(offset, 10) : 0,
    isAdult: false,
  });

  res.json({ items });
});

router.get('/genres', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
  const genres = mediaDB.getAllGenres();
  res.json({ genres });
});

router.get('/continue-watching', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
  const profileId = getProfileId(req);
  const showAdult = req.query.adult === 'true' || req.query.is_adult === 'true';
  const allowAdult = showAdult && isVaultAuthorized(req);
  const items = playbackDB.getContinueWatching(profileId, 15, allowAdult);
  res.json({ items });
});

// Grouped TV Series catalog
router.get('/series', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
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
router.get('/series/:name/seasons', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
  const { adult, is_adult } = req.query;
  const showAdult = adult === 'true' || is_adult === 'true';

  if (showAdult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required to access private series', vaultRequired: true });
  }

  const seriesName = decodeURIComponent(req.params.name);
  const profileId = getProfileId(req);
  const data = mediaDB.getSeriesSeasons(seriesName, showAdult, profileId);
  res.json(data);
});

// Re-tag all episodes of a TV series with optional disambiguation matchHint
router.post('/series/:name/retag', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
  const seriesName = decodeURIComponent(req.params.name);
  const matchHint = typeof req.body?.matchHint === 'string' ? req.body.matchHint.trim() : '';
  const showAdult = req.body?.adult === true || req.query.adult === 'true';

  if (showAdult && !isVaultAuthorized(req)) {
    return res.status(403).json({ error: 'Vault PIN required', vaultRequired: true });
  }

  const targetKey = normalizeSeriesKey(seriesName);
  const allItems = mediaDB.getAll({ limit: 2000, isAdult: showAdult });
  const episodes = allItems.filter(
    (m) => m.type === 'series' && normalizeSeriesKey(m.series_name || m.title || '') === targetKey
  );

  if (episodes.length === 0) {
    return res.status(404).json({ error: `No episodes found for series "${seriesName}"` });
  }

  // Sort chronologically so S01E01 enriches first and seeds canonical series_plot / year
  episodes.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));

  let updatedCount = 0;
  let finalSeriesName = seriesName;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    try {
      const updatedMeta = await enrichMediaMetadata(ep.filename || ep.gcs_path, ep.size_bytes, '', {
        matchHint: matchHint || seriesName,
      });
      const saved = await mediaDB.upsert({
        ...ep,
        ...updatedMeta,
        id: ep.id,
        gcs_path: ep.gcs_path,
        gcs_created_at: ep.gcs_created_at,
        created_at: ep.created_at,
        is_adult: Boolean(ep.is_adult || updatedMeta.is_adult),
      });
      if (saved.series_name) {
        finalSeriesName = saved.series_name;
      }
      updatedCount++;
      if (i < episodes.length - 1) {
        await new Promise((r) => setTimeout(r, 450));
      }
    } catch (err) {
      console.warn(`[Series Retag] Failed on ${ep.filename}:`, err.message);
    }
  }

  const seriesData = mediaDB.getSeriesSeasons(finalSeriesName, showAdult);
  res.json({ success: true, updatedCount, seriesName: finalSeriesName, data: seriesData });
});

router.get('/retag-status', requireAuth, (req, res) => {
  res.json(retagBatchState);
});

router.post('/retag-inaccurate', requireAuth, async (req, res) => {
  if (retagBatchState.inProgress) {
    return res.json({ message: 'Synopsis backfill already in progress', status: retagBatchState });
  }

  const forceAll = Boolean(req.body?.forceAll);
  const maxItems = Math.min(1000, Math.max(1, parseInt(req.body?.limit || '250', 10)));

  retagBatchState = {
    inProgress: true,
    total: 0,
    processed: 0,
    updated: 0,
    timestampsSynced: 0,
  };

  // Run non-blocking in background so Cloud Run / HTTP clients never time out
  (async () => {
    try {
      await ensureMediaCacheFresh(true);
      retagBatchState.timestampsSynced = await syncGcsTimestampsOnly();

      const publicItems = mediaDB.getAll({ limit: 2000, isAdult: false });
      const candidates = publicItems
        .filter(
          (item) =>
            forceAll ||
            isPlaceholderOrGenericPlot(item.plot) ||
            (item.type === 'series' && isPlaceholderOrGenericPlot(item.series_plot))
        )
        .slice(0, maxItems);

      retagBatchState.total = candidates.length;

      for (const item of candidates) {
        try {
          const enriched = await enrichMediaMetadata(item.filename || item.gcs_path, item.size_bytes);
          await mediaDB.upsert({
            ...item,
            ...enriched,
            id: item.id,
            gcs_path: item.gcs_path,
            gcs_created_at: item.gcs_created_at,
            created_at: item.created_at,
            is_adult: Boolean(item.is_adult),
          });
          retagBatchState.updated++;
        } catch (err) {
          console.warn(`[Backfill Retag] Failed for ${item.filename}:`, err.message);
        }
        retagBatchState.processed++;
        await new Promise((r) => setTimeout(r, 900));
      }
    } catch (err) {
      console.error('[Backfill Retag] Error:', err.message);
    } finally {
      retagBatchState.inProgress = false;
    }
  })();

  res.json({ message: 'GCS timestamp sync & synopsis backfill initiated in background', status: retagBatchState });
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

    // 1. Zero-CPU fast path: redirect directly to cached GCS Signed Read URL if thumbnail exists in GCS
    const redirectUrl = await getThumbnailRedirectUrl(item.id, item.gcs_path, variant);
    if (redirectUrl) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.redirect(302, redirectUrl);
    }

    // 2. Fallback: generate if brand-new item not yet in GCS
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
  await ensureMediaCacheFresh();
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

router.get('/:id', requireAuth, async (req, res) => {
  await ensureMediaCacheFresh();
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

  const profileId = getProfileId(req);
  const progress = playbackDB.getProgress(item.id, profileId);
  res.json({ item, progress });
});

router.post('/:id/retag', requireAuth, async (req, res) => {
  const item = mediaDB.getById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  try {
    const matchHint = typeof req.body?.matchHint === 'string' ? req.body.matchHint.trim() : '';
    const updatedMeta = await enrichMediaMetadata(item.filename || item.gcs_path, item.size_bytes, '', {
      matchHint,
    });
    const updated = await mediaDB.upsert({
      ...item,
      ...updatedMeta,
      id: item.id,
      gcs_path: item.gcs_path,
      gcs_created_at: item.gcs_created_at,
      created_at: item.created_at,
      is_adult: Boolean(item.is_adult || updatedMeta.is_adult),
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

  const updated = await mediaDB.upsert(
    {
      ...item,
      is_adult: newAdultState,
    },
    true
  );

  console.log(`[Vault Toggle] Moved "${item.title}" to ${newAdultState ? 'Private Vault' : 'Public Library'}`);
  res.json({ success: true, item: updated, is_adult: newAdultState });
});

router.delete('/:id', requireAuth, (req, res) => {
  mediaDB.delete(req.params.id);
  res.json({ success: true });
});

router.post('/playback/progress', requireAuth, async (req, res) => {
  const { mediaId, currentTime, duration, completed } = req.body || {};
  if (!mediaId) {
    return res.status(400).json({ error: 'mediaId is required' });
  }

  const profileId = getProfileId(req);
  const saved = await playbackDB.saveProgress(mediaId, currentTime, duration, completed, profileId);
  res.json({ success: true, progress: saved });
});

router.delete('/playback/:mediaId', requireAuth, async (req, res) => {
  const { mediaId } = req.params;
  if (!mediaId) {
    return res.status(400).json({ error: 'mediaId is required' });
  }

  const profileId = getProfileId(req);
  const saved = await playbackDB.markCompleted(mediaId, profileId);
  res.json({ success: true, progress: saved });
});

export default router;
