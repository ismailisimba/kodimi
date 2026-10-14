import { listFiles } from '../config/gcs.js';
import { mediaDB } from '../db/database.js';
import { enrichMediaMetadata } from './aiTagger.js';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.ts', '.m4v']);

let isScanning = false;
let scanStatus = {
  total: 0,
  processed: 0,
  added: 0,
  inProgress: false,
};

export function getScanStatus() {
  return scanStatus;
}

/**
 * Scans the GCS bucket for video files and indexes them in the catalog.
 */
export async function scanAndIndexBucket() {
  if (isScanning) {
    console.log('[Scanner] Scan already in progress.');
    return scanStatus;
  }

  isScanning = true;
  scanStatus = { total: 0, processed: 0, added: 0, inProgress: true };

  try {
    console.log('[Scanner] Fetching files from GCS bucket...');
    const allFiles = await listFiles();
    
    // Filter video files
    const videoFiles = allFiles.filter((f) => {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    });

    scanStatus.total = videoFiles.length;
    console.log(`[Scanner] Found ${videoFiles.length} video files in bucket.`);

    // Process files with controlled concurrency
    for (const file of videoFiles) {
      const existing = mediaDB.getByGcsPath(file.name);
      if (!existing) {
        console.log(`[Scanner] Indexing new file: ${file.name}`);
        try {
          const metadata = await enrichMediaMetadata(file.name, file.size);
          mediaDB.upsert({
            ...metadata,
            gcs_path: file.name,
          });
          scanStatus.added++;
        } catch (err) {
          console.error(`[Scanner] Failed to index ${file.name}:`, err.message);
        }
      } else {
        // Update size if missing
        if (!existing.size_bytes && file.size) {
          mediaDB.upsert({
            ...existing,
            size_bytes: file.size,
          });
        }
      }

      scanStatus.processed++;
    }

    console.log(`[Scanner] Scan completed. ${scanStatus.added} new media items indexed.`);
  } catch (err) {
    console.error('[Scanner] Error during bucket scan:', err);
  } finally {
    isScanning = false;
    scanStatus.inProgress = false;
  }

  return scanStatus;
}

export default {
  scanAndIndexBucket,
  getScanStatus,
};
