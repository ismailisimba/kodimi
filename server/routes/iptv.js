import express from 'express';
import { requireAuth, extractTokenFromRequest } from '../services/auth.js';
import {
  getChannels,
  getCategories,
  getChannelSchedule,
  proxyHlsStream,
  transcodeLiveStream,
  recordChannelRuntimeHealth,
} from '../services/iptvService.js';

const router = express.Router();

/**
 * GET /api/iptv/categories
 * Returns all categories and 6 countries / 3 continents with active live channel counts.
 */
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const data = await getCategories();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iptv/channels
 * Returns verified-first channels with EPG now-playing & up-next info.
 */
router.get('/channels', requireAuth, async (req, res) => {
  try {
    const { category, country, search, verifiedOnly, includeOffline, limit, offset } = req.query;
    const data = await getChannels({
      category,
      country,
      search,
      verifiedOnly: verifiedOnly === 'true' || verifiedOnly === '1',
      includeOffline: includeOffline === 'true' || includeOffline === '1',
      limit: limit ? parseInt(limit, 10) : 60,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    res.json({
      total: data.total,
      offset: data.offset,
      limit: data.limit,
      items: data.items,
      channels: data.items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iptv/channels/:id/schedule
 * Returns 24-hour EPG program schedule for a channel.
 */
router.get('/channels/:id/schedule', requireAuth, async (req, res) => {
  try {
    const data = await getChannelSchedule(req.params.id);
    if (!data) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/iptv/channels/:id/report-offline
 * Trips the runtime circuit breaker when the player detects an unreachable live channel.
 */
router.post('/channels/:id/report-offline', requireAuth, (req, res) => {
  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 80) : 'client-reported-offline';
  recordChannelRuntimeHealth(id, false, reason || 'client-reported-offline');
  res.json({ success: true });
});

/**
 * OPTIONS /api/iptv/proxy
 * Handle CORS preflight requests for HLS stream segments.
 */
router.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

/**
 * GET /api/iptv/proxy
 * Auth-protected & SSRF-safe live HLS proxy with post-redirect manifest rewriting and Referer/UA forwarding.
 */
router.get('/proxy', requireAuth, async (req, res) => {
  const { url, channelId } = req.query;
  if (!url) {
    return res.status(400).send('Stream URL parameter is required');
  }

  const token = extractTokenFromRequest(req) || '';
  await proxyHlsStream(String(url), req, res, {
    channelId: channelId ? String(channelId) : '',
    token,
  });
});

/**
 * GET /api/iptv/transcode
 * Auth-protected & SSRF-safe real-time downscaled/codec-compatible live transcode (720p, 480p, 360p).
 */
router.get('/transcode', requireAuth, async (req, res) => {
  const { url, quality, channelId } = req.query;
  if (!url) {
    return res.status(400).send('Stream URL parameter is required');
  }

  await transcodeLiveStream(String(url), quality ? String(quality) : '480p', req, res, {
    channelId: channelId ? String(channelId) : '',
  });
});

export default router;
