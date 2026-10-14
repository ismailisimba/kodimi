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
  downloadEvents,
} from '../services/downloader.js';
import { requireAuth } from '../services/auth.js';
import { getSignedWriteUrl, fileExists } from '../config/gcs.js';

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
