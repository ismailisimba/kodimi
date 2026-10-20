import express from 'express';
import { requireAuth } from '../services/auth.js';
import {
  getChannels,
  getCategories,
  getChannelSchedule,
  proxyHlsStream,
  transcodeLiveStream,
} from '../services/iptvService.js';

const router = express.Router();

/**
 * GET /api/iptv/categories
 * Returns all categories and countries with live channel counts.
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
 * Returns channels with EPG now-playing & up-next info.
 */
router.get('/channels', requireAuth, async (req, res) => {
  try {
    const { category, country, search, limit, offset } = req.query;
    const data = await getChannels({
      category,
      country,
      search,
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
 * Proxies live HLS streams and segments with dynamic manifest rewriting to bypass CORS restrictions.
 */
router.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('Stream URL parameter is required');
  }

  await proxyHlsStream(url, req, res);
});

/**
 * GET /api/iptv/transcode
 * Streams real-time downscaled live stream on-the-go (720p, 480p, 360p) for fixed feeds.
 */
router.get('/transcode', async (req, res) => {
  const { url, quality } = req.query;
  if (!url) {
    return res.status(400).send('Stream URL parameter is required');
  }

  await transcodeLiveStream(url, quality || '480p', req, res);
});

export default router;
