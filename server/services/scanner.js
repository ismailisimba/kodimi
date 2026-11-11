import { listFiles } from '../config/gcs.js';
import { mediaDB, toValidDate } from '../db/database.js';
import { enrichMediaMetadata } from './aiTagger.js';
import { getOrProbeDuration } from './transcoder.js';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.ts', '.m4v']);

let isScanning = false;
let scanStatus = {
  total: 0,
  processed: 0,
  added: 0,
  updatedTimestamps: 0,
  inProgress: false,
};

export function getScanStatus() {
  return scanStatus;
}

function extractGcsUploadDate(file) {
  return toValidDate(file?.timeCreated) || toValidDate(file?.updated) || null;
}

/**
 * Lightweight, zero-AI startup/maintenance pass that syncs authoritative GCS
 * `timeCreated` timestamps onto all existing catalog records.
 */
export async function syncGcsTimestampsOnly() {
  try {
    const allFiles = await listFiles();
    let updatedCount = 0;

    for (const file of allFiles) {
      if (!file.name || file.name.startsWith('.')) continue;
      const existing = mediaDB.getByGcsPath(file.name);
      if (!existing) continue;

      const gcsDate = extractGcsUploadDate(file);
      const existingGcsDate = toValidDate(existing.gcs_created_at);
      const needsTimestampSync =
        gcsDate && (!existingGcsDate || Math.abs(existingGcsDate.getTime() - gcsDate.getTime()) > 1000);
      const needsSizeSync = !existing.size_bytes && file.size > 0;

      if (needsTimestampSync || needsSizeSync) {
        await mediaDB.upsert({
          ...existing,
          size_bytes: file.size || existing.size_bytes,
          gcs_created_at: gcsDate || existing.gcs_created_at,
        });
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      console.log(`[Scanner] Synced authoritative GCS upload timestamps for ${updatedCount} existing catalog item(s).`);
    }
    return updatedCount;
  } catch (err) {
    console.warn('[Scanner] GCS timestamp sync warning:', err.message);
    return 0;
  }
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
  scanStatus = { total: 0, processed: 0, added: 0, updatedTimestamps: 0, inProgress: true };

  try {
    console.log('[Scanner] Fetching files from GCS bucket...');
    const allFiles = await listFiles();

    // Filter video files (excluding hidden system prefixes like .thumbnails/ and .subtitles/)
    const videoFiles = allFiles.filter((f) => {
      if (f.name.startsWith('.')) return false;
      const dotIdx = f.name.lastIndexOf('.');
      if (dotIdx === -1) return false;
      const ext = f.name.slice(dotIdx).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    });

    scanStatus.total = videoFiles.length;
    console.log(`[Scanner] Found ${videoFiles.length} video files in bucket.`);

    // Process files sequentially with gentle pacing for AI calls
    for (const file of videoFiles) {
      const existing = mediaDB.getByGcsPath(file.name);
      const gcsCreatedAt = extractGcsUploadDate(file) || new Date();

      if (!existing) {
        console.log(`[Scanner] Indexing new file: ${file.name}`);
        try {
          const metadata = await enrichMediaMetadata(file.name, file.size);
          const saved = await mediaDB.upsert({
            ...metadata,
            gcs_path: file.name,
            gcs_created_at: gcsCreatedAt,
            created_at: gcsCreatedAt,
          });
          scanStatus.added++;
          // Probe duration in background for newly added file
          getOrProbeDuration(saved.id, file.name).catch(() => {});
          // Gentle pacing to avoid Gemini burst rate limits on large season packs
          await new Promise((r) => setTimeout(r, 350));
        } catch (err) {
          console.error(`[Scanner] Failed to index ${file.name}:`, err.message);
        }
      } else {
        // Sync authoritative GCS timestamp or missing size_bytes on existing items
        const existingGcsDate = toValidDate(existing.gcs_created_at);
        const needsTimestampSync =
          !existingGcsDate || Math.abs(existingGcsDate.getTime() - gcsCreatedAt.getTime()) > 1000;
        const needsSizeSync = !existing.size_bytes && file.size > 0;

        if (needsTimestampSync || needsSizeSync) {
          await mediaDB.upsert({
            ...existing,
            size_bytes: file.size || existing.size_bytes,
            gcs_created_at: gcsCreatedAt,
          });
          if (needsTimestampSync) {
            scanStatus.updatedTimestamps++;
          }
        }
        if (!existing.duration || existing.duration <= 0) {
          getOrProbeDuration(existing.id, file.name).catch(() => {});
        }
      }

      scanStatus.processed++;
    }

    console.log(
      `[Scanner] Scan completed. ${scanStatus.added} new media items indexed, ${scanStatus.updatedTimestamps} GCS timestamps synced.`
    );
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
  syncGcsTimestampsOnly,
  getScanStatus,
};
