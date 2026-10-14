import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';
import { createWriteStream, fileExists } from '../config/gcs.js';
import { downloadsDB, mediaDB } from '../db/database.js';
import { enrichMediaMetadata } from './aiTagger.js';

export const downloadEvents = new EventEmitter();

// Active in-memory download jobs
const activeJobs = new Map();

let webTorrentClient = null;

async function getWebTorrentClient() {
  if (!webTorrentClient) {
    const WebTorrentModule = await import('webtorrent');
    const WebTorrent = WebTorrentModule.default || WebTorrentModule;
    webTorrentClient = new WebTorrent({
      maxConns: 55,
      dht: true,
    });

    webTorrentClient.on('error', (err) => {
      console.error('[WebTorrent Error]:', err.message);
    });
  }
  return webTorrentClient;
}

/**
 * Initiates a download (magnet, torrent, or direct HTTP/HTTPS link).
 */
export async function startDownload(sourceUrl, customName = '') {
  const isMagnet = sourceUrl.startsWith('magnet:?');
  const isTorrent = sourceUrl.endsWith('.torrent') || sourceUrl.includes('torrent');
  const isDirect = !isMagnet && (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://'));

  const id = crypto.randomUUID();
  const sourceType = isMagnet ? 'magnet' : isTorrent ? 'torrent' : 'direct';
  const name = customName || (isMagnet ? 'Torrent Ingestion' : path.basename(new URL(sourceUrl).pathname)) || `media-${Date.now()}`;

  const downloadRecord = {
    id,
    name,
    source_type: sourceType,
    source_url: sourceUrl,
    status: 'downloading',
    progress: 0,
    speed: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    peers: 0,
    error: null,
    gcs_path: null,
  };

  downloadsDB.upsert(downloadRecord);
  activeJobs.set(id, { ...downloadRecord });
  broadcastProgress(downloadRecord);

  if (isMagnet || isTorrent) {
    processTorrentDownload(id, sourceUrl, customName);
  } else if (isDirect) {
    processDirectDownload(id, sourceUrl, customName);
  } else {
    failDownload(id, 'Unsupported URL format');
  }

  return downloadRecord;
}

/**
 * Handles WebTorrent magnet or torrent link ingestion straight into GCS.
 */
async function processTorrentDownload(id, torrentId, customName) {
  try {
    const client = await getWebTorrentClient();

    client.add(torrentId, (torrent) => {
      console.log(`[Torrent] Metadata loaded for: ${torrent.name}`);

      // Identify the largest video file
      const videoFile = torrent.files.reduce((prev, current) => {
        return (prev.length > current.length) ? prev : current;
      });

      if (!videoFile) {
        failDownload(id, 'No video file found in torrent');
        torrent.destroy();
        return;
      }

      const cleanFilename = customName ? `${customName}${path.extname(videoFile.name)}` : videoFile.name;
      const gcsPath = cleanFilename;
      const totalBytes = videoFile.length;

      updateDownload(id, {
        name: cleanFilename,
        total_bytes: totalBytes,
        gcs_path: gcsPath,
      });

      const writeStream = createWriteStream(gcsPath);
      const readStream = videoFile.createReadStream();

      let downloadedBytes = 0;
      let lastTime = Date.now();
      let lastBytes = 0;

      readStream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;

        if (elapsed >= 1) {
          const speed = (downloadedBytes - lastBytes) / elapsed; // bytes per sec
          const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

          updateDownload(id, {
            downloaded_bytes: downloadedBytes,
            progress: Math.min(100, Math.round(progress * 10) / 10),
            speed: Math.round(speed),
            peers: torrent.numPeers || 0,
          });

          lastTime = now;
          lastBytes = downloadedBytes;
        }
      });

      readStream.on('error', (err) => {
        failDownload(id, `Torrent read stream error: ${err.message}`);
        torrent.destroy();
      });

      writeStream.on('error', (err) => {
        failDownload(id, `GCS write stream error: ${err.message}`);
        torrent.destroy();
      });

      writeStream.on('finish', async () => {
        console.log(`[Torrent] Successfully saved ${cleanFilename} to GCS bucket!`);
        completeDownload(id, gcsPath, totalBytes);
        torrent.destroy();
      });

      readStream.pipe(writeStream);
    });
  } catch (err) {
    failDownload(id, err.message);
  }
}

/**
 * Handles direct HTTP/HTTPS link download straight into GCS.
 */
async function processDirectDownload(id, url, customName) {
  try {
    const headResponse = await axios.head(url, { timeout: 15000 }).catch(() => null);
    const totalBytes = headResponse ? parseInt(headResponse.headers['content-length'] || '0', 10) : 0;
    
    let filename = customName;
    if (!filename) {
      const pathname = new URL(url).pathname;
      filename = path.basename(pathname) || `download-${Date.now()}.mp4`;
    }
    if (!path.extname(filename)) {
      filename += '.mp4';
    }

    const gcsPath = filename;

    updateDownload(id, {
      name: filename,
      total_bytes: totalBytes,
      gcs_path: gcsPath,
    });

    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 30000,
    });

    const writeStream = createWriteStream(gcsPath);

    let downloadedBytes = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;

      if (elapsed >= 1) {
        const speed = (downloadedBytes - lastBytes) / elapsed;
        const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

        updateDownload(id, {
          downloaded_bytes: downloadedBytes,
          progress: Math.min(100, Math.round(progress * 10) / 10),
          speed: Math.round(speed),
        });

        lastTime = now;
        lastBytes = downloadedBytes;
      }
    });

    response.data.on('error', (err) => {
      failDownload(id, `Direct stream error: ${err.message}`);
    });

    writeStream.on('error', (err) => {
      failDownload(id, `GCS write error: ${err.message}`);
    });

    writeStream.on('finish', () => {
      console.log(`[Direct] Successfully saved ${gcsPath} to GCS bucket!`);
      completeDownload(id, gcsPath, totalBytes || downloadedBytes);
    });

    response.data.pipe(writeStream);
  } catch (err) {
    failDownload(id, err.message);
  }
}

function updateDownload(id, partial) {
  const job = activeJobs.get(id);
  if (!job) return;

  Object.assign(job, partial);
  downloadsDB.upsert(job);
  broadcastProgress(job);
}

async function completeDownload(id, gcsPath, totalBytes) {
  const job = activeJobs.get(id);
  if (!job) return;

  job.status = 'completed';
  job.progress = 100;
  job.speed = 0;
  job.downloaded_bytes = totalBytes;
  downloadsDB.upsert(job);
  broadcastProgress(job);
  activeJobs.delete(id);

  // Auto-enrich and index into media catalog
  try {
    const metadata = await enrichMediaMetadata(gcsPath, totalBytes);
    mediaDB.upsert({
      ...metadata,
      gcs_path: gcsPath,
    });
    console.log(`[Catalog] Automatically indexed downloaded media: ${metadata.title}`);
  } catch (err) {
    console.error(`[Catalog] Failed to auto-index ${gcsPath}:`, err.message);
  }
}

function failDownload(id, errorMsg) {
  const job = activeJobs.get(id);
  if (job) {
    job.status = 'failed';
    job.error = errorMsg;
    downloadsDB.upsert(job);
    broadcastProgress(job);
    activeJobs.delete(id);
  }
  console.error(`[Download Failed - ${id}]: ${errorMsg}`);
}

function broadcastProgress(data) {
  downloadEvents.emit('progress', data);
}

export function cancelDownload(id) {
  const job = activeJobs.get(id);
  if (job) {
    job.status = 'failed';
    job.error = 'Cancelled by user';
    downloadsDB.upsert(job);
    broadcastProgress(job);
    activeJobs.delete(id);
    return true;
  }
  return false;
}

export default {
  startDownload,
  cancelDownload,
  downloadEvents,
};
