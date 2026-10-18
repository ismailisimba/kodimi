import express from 'express';
import path from 'path';
import { downloadsDB } from '../db/database.js';
import {
  startDownload,
  startTorrentFromBuffer,
  registerDirectUpload,
  completeDirectUpload,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  hasActiveDownloads,
  downloadEvents,
} from '../services/downloader.js';
import { requireAuth } from '../services/auth.js';
import { getSignedWriteUrl, fileExists } from '../config/gcs.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const downloads = await downloadsDB.getAllAsync();
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

/**
 * Request a GCS signed write URL to upload a video or media file directly from browser.
 */
router.post('/request-upload', requireAuth, async (req, res) => {
  const { filename, size } = req.body;

  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  const cleanFilename = path.basename(filename).replace(/[\r\n\0]/g, '');

  try {
    const uploadUrl = await getSignedWriteUrl(cleanFilename, 180);
    const downloadRecord = registerDirectUpload(cleanFilename, size || 0);

    res.json({
      success: true,
      uploadUrl,
      filename: cleanFilename,
      downloadId: downloadRecord.id,
    });
  } catch (err) {
    console.error('[Upload Request Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Complete direct upload: auto-indexes and tags file with Gemini AI into the catalog.
 */
router.post('/complete-upload', requireAuth, async (req, res) => {
  const { filename, size, downloadId } = req.body;

  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  const cleanFilename = path.basename(filename);

  try {
    const exists = await fileExists(cleanFilename);
    if (!exists) {
      return res.status(400).json({ error: `File "${cleanFilename}" was not found in bucket.` });
    }

    const saved = await completeDirectUpload(downloadId, cleanFilename, size || 0);
    res.json({ success: true, item: saved });
  } catch (err) {
    console.error('[Upload Complete Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Ingest an uploaded .torrent file buffer.
 */
router.post('/upload-torrent', requireAuth, async (req, res) => {
  const { filename, data } = req.body;

  if (!data) {
    return res.status(400).json({ error: 'Torrent data is required' });
  }

  try {
    const buffer = Buffer.from(data, 'base64');
    const cleanFilename = path.basename(filename || `torrent-${Date.now()}.torrent`);
    const job = await startTorrentFromBuffer(buffer, cleanFilename);
    res.json({ success: true, download: job });
  } catch (err) {
    console.error('[Upload Torrent Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/pause', requireAuth, (req, res) => {
  const { id } = req.params;
  const paused = pauseDownload(id);
  res.json({ success: true, paused });
});

router.post('/:id/resume', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const job = await resumeDownload(id);
    res.json({ success: true, download: job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  cancelDownload(id, false);
  await downloadsDB.deleteAsync(id);
  res.json({ success: true });
});

/**
 * Internal worker keep-alive endpoint: keeps Cloud Run CPU allocated strictly while a download is active,
 * and closes immediately once all downloads finish so the instance scales to zero ($0/hr).
 */
router.get('/worker-keepalive', (req, res) => {
  if (!hasActiveDownloads()) {
    return res.status(200).send('idle');
  }

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('active\n');

  const cleanup = () => {
    clearInterval(pingInterval);
    clearTimeout(maxTimer);
    downloadEvents.off('idle', onIdle);
    try { res.end('done\n'); } catch (_) {}
  };

  const onIdle = () => cleanup();
  downloadEvents.once('idle', onIdle);

  const pingInterval = setInterval(() => {
    if (!hasActiveDownloads()) {
      cleanup();
      return;
    }
    try {
      res.write('.\n');
    } catch (_) {
      cleanup();
    }
  }, 15000);

  const maxTimer = setTimeout(() => cleanup(), 12 * 60 * 1000);

  req.on('close', () => {
    clearInterval(pingInterval);
    clearTimeout(maxTimer);
    downloadEvents.off('idle', onIdle);
  });
});

/**
 * Server-Sent Events (SSE) for live download progress updates.
 * Automatically closes when no downloads are active so idle browser tabs never keep Cloud Run awake.
 */
router.get('/events', requireAuth, (req, res) => {
  if (!hasActiveDownloads()) {
    return res.status(204).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const cleanup = () => {
    clearInterval(pingInterval);
    downloadEvents.off('progress', onProgress);
    downloadEvents.off('idle', onIdle);
    try { res.end(); } catch (_) {}
  };

  const onProgress = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      cleanup();
    }
  };

  const onIdle = () => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'idle' })}\n\n`);
    } catch (_) {}
    cleanup();
  };

  downloadEvents.on('progress', onProgress);
  downloadEvents.once('idle', onIdle);

  // Send initial ping
  res.write(': connected\n\n');

  // Heartbeat ping every 15s ONLY while downloads are active
  const pingInterval = setInterval(() => {
    if (!hasActiveDownloads()) {
      onIdle();
      return;
    }
    try {
      res.write(': keepalive\n\n');
    } catch (_) {
      cleanup();
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    downloadEvents.off('progress', onProgress);
    downloadEvents.off('idle', onIdle);
  });
});

export default router;
