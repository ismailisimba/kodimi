import { Storage } from '@google-cloud/storage';
import { config } from './env.js';

let storageInstance = null;
let bucketInstance = null;

export function getStorage() {
  if (!storageInstance) {
    const options = {
      projectId: config.gcpProjectId,
    };
    if (config.gcpKeyFile) {
      options.keyFilename = config.gcpKeyFile;
    }
    storageInstance = new Storage(options);
  }
  return storageInstance;
}

export function getBucket() {
  if (!bucketInstance) {
    const storage = getStorage();
    bucketInstance = storage.bucket(config.gcsBucketName);
  }
  return bucketInstance;
}

/**
 * Checks if a file exists in the GCS bucket.
 * @param {string} filename 
 * @returns {Promise<boolean>}
 */
export async function fileExists(filename) {
  try {
    const bucket = getBucket();
    const [exists] = await bucket.file(filename).exists();
    return exists;
  } catch (err) {
    console.error(`[GCS fileExists error for ${filename}]:`, err.message);
    return false;
  }
}

/**
 * Gets file metadata (size, content type, etc.)
 * @param {string} filename 
 * @returns {Promise<{size: number, contentType: string, updated: string}>}
 */
export async function getFileMetadata(filename) {
  const bucket = getBucket();
  const [metadata] = await bucket.file(filename).getMetadata();
  return {
    size: parseInt(metadata.size, 10) || 0,
    contentType: metadata.contentType || 'application/octet-stream',
    updated: metadata.updated,
  };
}

/**
 * Creates a readable stream for a GCS file, supporting range requests.
 * @param {string} filename 
 * @param {{start?: number, end?: number}} options 
 */
export function createReadStream(filename, options = {}) {
  const bucket = getBucket();
  return bucket.file(filename).createReadStream(options);
}

/**
 * Creates a writable stream directly into GCS.
 * @param {string} filename 
 * @param {object} options 
 */
export function createWriteStream(filename, options = {}) {
  const bucket = getBucket();
  return bucket.file(filename).createWriteStream({
    resumable: true,
    ...options,
  });
}

/**
 * Lists all files in the bucket, optionally with a prefix.
 * @param {string} prefix 
 */
export async function listFiles(prefix = '') {
  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix });
  return files.map((f) => ({
    name: f.name,
    size: parseInt(f.metadata?.size || '0', 10),
    contentType: f.metadata?.contentType,
    updated: f.metadata?.updated,
  }));
}

/**
 * Generates a signed read URL for a file in GCS.
 * @param {string} filename
 * @param {number} expiresInMinutes
 */
export async function getSignedReadUrl(filename, expiresInMinutes = 60) {
  const bucket = getBucket();
  const [url] = await bucket.file(filename).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInMinutes * 60 * 1000,
  });
  return url;
}

export default {
  getStorage,
  getBucket,
  fileExists,
  getFileMetadata,
  createReadStream,
  createWriteStream,
  listFiles,
  getSignedReadUrl,
};
