import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';
import { createWriteStream, fileExists } from '../config/gcs.js';
import { downloadsDB, mediaDB } from '../db/database.js';
import { enrichMediaMetadata } from './aiTagger.js';
import { getOrProbeDuration } from './transcoder.js';

export const downloadEvents = new EventEmitter();

// Supported media formats
const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.webm', '.ts', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.vob', '.m2ts'
]);

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
 * Initiates a download (magnet, torrent URL, or direct HTTP/HTTPS link).
 */
export async function startDownload(sourceUrl, customName = '') {
  const isMagnet = typeof sourceUrl === 'string' && sourceUrl.startsWith('magnet:?');
  const isTorrent = typeof sourceUrl === 'string' && (sourceUrl.endsWith('.torrent') || sourceUrl.includes('torrent'));
  const isDirect = typeof sourceUrl === 'string' && !isMagnet && (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://'));

  const id = crypto.randomUUID();
  const sourceType = isMagnet ? 'magnet' : isTorrent ? 'torrent' : 'direct';
  const name = customName || (isMagnet ? 'Torrent Ingestion' : path.basename(new URL(sourceUrl).pathname)) || `media-${Date.now()}`;

  const downloadRecord = {
    id,
    name,
    source_type: sourceType,
    source_url: typeof sourceUrl === 'string' ? sourceUrl : 'buffer',
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
 * Initiates torrent download directly from an uploaded .torrent file buffer.
 */
export async function startTorrentFromBuffer(buffer, originalFilename = '') {
  const id = crypto.randomUUID();
  const name = originalFilename || `torrent-${Date.now()}`;

  const downloadRecord = {
    id,
    name,
    source_type: 'torrent',
    source_url: originalFilename,
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

  processTorrentDownload(id, buffer, '');
  return downloadRecord;
}

/**
 * Registers an in-flight direct file upload in the active jobs database.
 */
export function registerDirectUpload(filename, size = 0) {
  const id = crypto.randomUUID();
  const downloadRecord = {
    id,
    name: filename,
    source_type: 'upload',
    source_url: 'direct-upload',
    status: 'uploading',
    progress: 0,
    speed: 0,
    downloaded_bytes: 0,
    total_bytes: size || 0,
    peers: 0,
    error: null,
    gcs_path: filename,
  };

  downloadsDB.upsert(downloadRecord);
  activeJobs.set(id, { ...downloadRecord });
  broadcastProgress(downloadRecord);
  return downloadRecord;
}

/**
 * Marks direct file upload as complete and indexes it into the media catalog.
 */
export async function completeDirectUpload(id, filename, size = 0) {
  let job = activeJobs.get(id);
  if (!job) {
    job = downloadsDB.getById(id) || {
      id,
      name: filename,
      source_type: 'upload',
      status: 'uploading',
      total_bytes: size,
    };
  }

  job.status = 'completed';
  job.progress = 100;
  job.speed = 0;
  job.downloaded_bytes = size;
  downloadsDB.upsert(job);
  broadcastProgress(job);
  activeJobs.delete(id);

  // Auto-enrich and index into media catalog
  try {
    const metadata = await enrichMediaMetadata(filename, size);
    const saved = mediaDB.upsert({
      ...metadata,
      gcs_path: filename,
    });
    getOrProbeDuration(saved.id, filename).catch(() => {});
    console.log(`[Catalog] Direct upload successfully indexed: ${metadata.title}`);
    return saved;
  } catch (err) {
    console.error(`[Catalog] Failed to auto-index uploaded file ${filename}:`, err.message);
    throw err;
  }
}

/**
 * Handles WebTorrent magnet or torrent link ingestion straight into GCS.
 * Downloads ALL video files contained in multi-file torrents sequentially.
 */
async function processTorrentDownload(id, torrentSource, customName) {
  try {
    const client = await getWebTorrentClient();

    client.add(torrentSource, async (torrent) => {
      console.log(`[Torrent] Metadata loaded for: "${torrent.name}" (total ${torrent.files.length} file(s))`);

      const job = activeJobs.get(id);
      if (job) {
        job.torrent = torrent;
      }

      // Filter for all valid media files
      const videoFiles = torrent.files.filter((f) => {
        const ext = path.extname(f.name).toLowerCase();
        return VIDEO_EXTENSIONS.has(ext);
      });

      // If no recognized video extensions match, include all files in torrent
      const targetFiles = videoFiles.length > 0 ? videoFiles : torrent.files;

      if (!targetFiles || targetFiles.length === 0) {
        failDownload(id, 'No media files found in torrent');
        torrent.destroy();
        return;
      }

      // Calculate total bytes across all target files
      const totalBytes = targetFiles.reduce((sum, f) => sum + f.length, 0);
      const isMultiFile = targetFiles.length > 1;

      console.log(`[Torrent] Downloading ${targetFiles.length} media file(s) for "${torrent.name}", total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);

      updateDownload(id, {
        name: isMultiFile ? `${torrent.name} (${targetFiles.length} files)` : (customName || targetFiles[0].name),
        total_bytes: totalBytes,
        gcs_path: isMultiFile ? `${torrent.name}/` : targetFiles[0].name,
      });

      let totalDownloadedPrev = 0;
      let lastProgressTime = Date.now();
      let lastProgressBytes = 0;

      // Sequentially stream and upload each file to GCS
      for (let i = 0; i < targetFiles.length; i++) {
        const currentFile = targetFiles[i];

        // Ensure job has not been cancelled
        const currentJob = activeJobs.get(id);
        if (!currentJob || currentJob.status === 'failed') {
          console.log(`[Torrent] Job ${id} was cancelled, stopping multi-file download.`);
          break;
        }

        const cleanFilename = (!isMultiFile && customName)
          ? `${customName}${path.extname(currentFile.name)}`
          : currentFile.name;
        const gcsPath = cleanFilename;
        const fileBytes = currentFile.length;

        updateDownload(id, {
          name: isMultiFile
            ? `[${i + 1}/${targetFiles.length}] ${cleanFilename} (${torrent.name})`
            : cleanFilename,
          gcs_path: gcsPath,
        });

        console.log(`[Torrent] Starting file ${i + 1}/${targetFiles.length}: "${cleanFilename}" (${(fileBytes / (1024 * 1024)).toFixed(1)} MB)`);

        try {
          await new Promise((resolve, reject) => {
            const writeStream = createWriteStream(gcsPath);
            const readStream = currentFile.createReadStream();
            let currentFileDownloaded = 0;

            if (job) {
              job.currentWriteStream = writeStream;
              job.currentReadStream = readStream;
            }

            readStream.on('data', (chunk) => {
              currentFileDownloaded += chunk.length;
              const totalSoFar = totalDownloadedPrev + currentFileDownloaded;
              const now = Date.now();
              const elapsed = (now - lastProgressTime) / 1000;

              if (elapsed >= 0.8) {
                const speed = (totalSoFar - lastProgressBytes) / elapsed;
                const progress = totalBytes > 0 ? (totalSoFar / totalBytes) * 100 : 0;

                updateDownload(id, {
                  downloaded_bytes: totalSoFar,
                  progress: Math.min(100, Math.round(progress * 10) / 10),
                  speed: Math.round(speed),
                  peers: torrent.numPeers || 0,
                });

                lastProgressTime = now;
                lastProgressBytes = totalSoFar;
              }
            });

            readStream.on('error', (err) => {
              console.error(`[Torrent Read Error for ${cleanFilename}]:`, err.message);
              reject(err);
            });

            writeStream.on('error', (err) => {
              console.error(`[GCS Write Error for ${cleanFilename}]:`, err.message);
              reject(err);
            });

            writeStream.on('finish', async () => {
              totalDownloadedPrev += fileBytes;
              console.log(`[Torrent] Successfully saved file ${i + 1}/${targetFiles.length} to GCS: ${cleanFilename}`);

              // Immediately enrich and index this completed file into Kodimi media catalog!
              try {
                const metadata = await enrichMediaMetadata(cleanFilename, fileBytes);
                const saved = mediaDB.upsert({
                  ...metadata,
                  gcs_path: cleanFilename,
                });
                getOrProbeDuration(saved.id, cleanFilename).catch(() => {});
                console.log(`[Catalog] Automatically indexed multi-file item: ${metadata.title}`);
              } catch (err) {
                console.error(`[Catalog] Failed to auto-index ${cleanFilename}:`, err.message);
              }

              resolve();
            });

            readStream.pipe(writeStream);
          });
        } catch (streamErr) {
          console.error(`[Torrent] Failed while processing ${cleanFilename}:`, streamErr.message);
          // If a single file fails, fail the overall job
          failDownload(id, `File download failed: ${streamErr.message}`);
          torrent.destroy();
          return;
        }
      }

      // Check final state
      const finalJob = activeJobs.get(id);
      if (finalJob && finalJob.status !== 'failed') {
        console.log(`[Torrent] Successfully completed all ${targetFiles.length} file(s) for: ${torrent.name}`);
        completeDownload(id, (customName || torrent.name), totalBytes);
      }
      torrent.destroy();
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

  // Auto-enrich and index into media catalog if single file
  try {
    const metadata = await enrichMediaMetadata(gcsPath, totalBytes);
    mediaDB.upsert({
      ...metadata,
      gcs_path: gcsPath,
    });
    console.log(`[Catalog] Automatically indexed downloaded media: ${metadata.title}`);
  } catch (err) {
    console.log(`[Catalog] Ingestion completed for ${gcsPath}`);
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
    if (job.torrent) {
      try { job.torrent.destroy(); } catch (_) {}
    }
    if (job.currentReadStream) {
      try { job.currentReadStream.destroy(); } catch (_) {}
    }
    if (job.currentWriteStream) {
      try { job.currentWriteStream.end(); } catch (_) {}
    }
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
  startTorrentFromBuffer,
  registerDirectUpload,
  completeDirectUpload,
  cancelDownload,
  downloadEvents,
};
