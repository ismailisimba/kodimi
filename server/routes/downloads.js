import express from 'express';
import { downloadsDB } from '../db/database.js';
import { startDownload, cancelDownload, downloadEvents } from '../services/downloader.js';
import { requireAuth } from '../services/auth.js';

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const downloads = downloadsDB.getAll();
  res.json({ downloads });
});

router.post('/', requireAuth, async (req, res) => {
  const { url, name } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Download URL is required' });
  }

  try {
    const job = await startDownload(url, name);
    res.json({ success: true, download: job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const cancelled = cancelDownload(id);
  downloadsDB.delete(id);
  res.json({ success: true, cancelled });
});

/**
 * Server-Sent Events (SSE) for live download progress updates.
 */
router.get('/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  downloadEvents.on('progress', onProgress);

  // Send initial ping
  res.write(': connected\n\n');

  req.on('close', () => {
    downloadEvents.off('progress', onProgress);
  });
});

export default router;
