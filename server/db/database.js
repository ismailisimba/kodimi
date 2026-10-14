import dns from 'node:dns';
// Resolve DNS SRV lookups reliably across platforms
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Mongoose Schemas & Models
// ==========================================

const MediaSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  gcs_path: { type: String, required: true, unique: true, index: true },
  filename: String,
  title: { type: String, index: true },
  type: { type: String, default: 'movie', index: true },
  series_name: { type: String, index: true },
  season: Number,
  episode: Number,
  year: Number,
  plot: String,
  genres: [String],
  tags: [String],
  poster_url: String,
  backdrop_url: String,
  duration: { type: Number, default: 0 },
  size_bytes: { type: Number, default: 0 },
  resolution: String,
  video_codec: String,
  audio_codec: String,
  is_adult: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const PlaybackSchema = new mongoose.Schema({
  media_id: { type: String, required: true, unique: true, index: true },
  current_time: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  updated_at: { type: Date, default: Date.now },
});

const DownloadSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  source_type: String,
  source_url: String,
  status: { type: String, default: 'queued', index: true },
  progress: { type: Number, default: 0 },
  speed: { type: Number, default: 0 },
  downloaded_bytes: { type: Number, default: 0 },
  total_bytes: { type: Number, default: 0 },
  peers: { type: Number, default: 0 },
  error: String,
  gcs_path: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

export const MediaModel = mongoose.model('Media', MediaSchema);
export const PlaybackModel = mongoose.model('Playback', PlaybackSchema);
export const DownloadModel = mongoose.model('Download', DownloadSchema);

// In-Memory caches for high-speed synchronous retrieval
let mediaCache = new Map();
let playbackCache = new Map();
let downloadCache = new Map();

/**
 * Connect to MongoDB and sync in-memory cache
 */
export async function initDatabase() {
  const uri = config.mongoUri;
  if (!uri) {
    console.warn('[DB] No MONGO_URI provided in .env!');
    return;
  }

  try {
    console.log('[DB] Connecting to MongoDB...');
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
    });
    console.log('[DB] MongoDB connected successfully to database:', mongoose.connection.name);

    // Initial cache population
    await refreshCache();

    // Check if we can migrate from existing SQLite database
    const mongoCount = await MediaModel.countDocuments();
    if (mongoCount === 0) {
      await migrateFromSqlite();
    }
  } catch (err) {
    console.error('[DB] MongoDB Connection Error:', err.message);
  }
}

async function refreshCache() {
  try {
    const allMedia = await MediaModel.find({}).lean();
    mediaCache.clear();
    allMedia.forEach((m) => mediaCache.set(m.id, m));

    const allPlayback = await PlaybackModel.find({}).lean();
    playbackCache.clear();
    allPlayback.forEach((p) => playbackCache.set(p.media_id, p));

    const allDownloads = await DownloadModel.find({}).sort({ created_at: -1 }).lean();
    downloadCache.clear();
    allDownloads.forEach((d) => downloadCache.set(d.id, d));

    console.log(`[DB] Cache populated with ${mediaCache.size} media items from MongoDB.`);
  } catch (err) {
    console.error('[DB] Cache refresh error:', err.message);
  }
}

/**
 * Migrates existing SQLite items from data/kodimi.db into MongoDB
 */
async function migrateFromSqlite() {
  const sqliteDbPath = path.resolve(__dirname, '../../data/kodimi.db');
  if (!fs.existsSync(sqliteDbPath)) return;

  try {
    console.log('[DB Migration] Migrating indexed records from SQLite to MongoDB...');
    const { DatabaseSync } = await import('node:sqlite');
    const sqliteDb = new DatabaseSync(sqliteDbPath);
    const rows = sqliteDb.prepare('SELECT * FROM media').all();

    if (rows && rows.length > 0) {
      const docs = rows.map((r) => ({
        id: r.id,
        gcs_path: r.gcs_path,
        filename: r.filename,
        title: r.title,
        type: r.type,
        series_name: r.series_name,
        season: r.season,
        episode: r.episode,
        year: r.year,
        plot: r.plot,
        genres: safeJsonParse(r.genres, []),
        tags: safeJsonParse(r.tags, []),
        poster_url: r.poster_url,
        backdrop_url: r.backdrop_url,
        duration: r.duration || 0,
        size_bytes: r.size_bytes || 0,
        resolution: r.resolution,
        video_codec: r.video_codec,
        audio_codec: r.audio_codec,
        is_adult: Boolean(r.is_adult),
        created_at: r.created_at ? new Date(r.created_at) : new Date(),
        updated_at: r.updated_at ? new Date(r.updated_at) : new Date(),
      }));

      await MediaModel.bulkWrite(
        docs.map((doc) => ({
          updateOne: {
            filter: { gcs_path: doc.gcs_path },
            update: { $set: doc },
            upsert: true,
          },
        }))
      );

      console.log(`[DB Migration] Successfully migrated ${docs.length} items into MongoDB!`);
      await refreshCache();
    }
  } catch (err) {
    console.error('[DB Migration Error]:', err.message);
  }
}

// Media Catalog DB Methods
export const mediaDB = {
  getAll: (options = {}) => {
    const { type, genre, search, limit = 500, offset = 0, isAdult = false } = options;
    let list = Array.from(mediaCache.values());

    if (!isAdult) {
      list = list.filter((m) => !m.is_adult);
    } else {
      list = list.filter((m) => Boolean(m.is_adult));
    }

    if (type) {
      list = list.filter((m) => m.type === type);
    }

    if (genre) {
      list = list.filter((m) => m.genres && m.genres.includes(genre));
    }

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((m) => {
        const inTitle = m.title?.toLowerCase().includes(q);
        const inSeries = m.series_name?.toLowerCase().includes(q);
        const inPlot = m.plot?.toLowerCase().includes(q);
        const inTags = m.tags?.some((t) => t.toLowerCase().includes(q));
        return inTitle || inSeries || inPlot || inTags;
      });
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return list.slice(offset, offset + limit);
  },

  getById: (id) => {
    return mediaCache.get(id) || null;
  },

  getByGcsPath: (gcsPath) => {
    for (const item of mediaCache.values()) {
      if (item.gcs_path === gcsPath) return item;
    }
    return null;
  },

  upsert: async (item) => {
    const docData = {
      ...item,
      updated_at: new Date(),
    };

    // Update in-memory cache immediately
    mediaCache.set(item.id, docData);

    // Persist to MongoDB
    try {
      await MediaModel.findOneAndUpdate(
        { gcs_path: item.gcs_path },
        { $set: docData },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (err) {
      console.error('[DB Upsert Error]:', err.message);
    }

    return docData;
  },

  delete: (id) => {
    mediaCache.delete(id);
    MediaModel.deleteOne({ id }).catch((err) => console.error('[DB Delete Error]:', err.message));
  },

  getAllGenres: () => {
    const genreSet = new Set();
    for (const item of mediaCache.values()) {
      if (!item.is_adult && Array.isArray(item.genres)) {
        item.genres.forEach((g) => genreSet.add(g));
      }
    }
    return Array.from(genreSet).sort();
  },
};

// Playback Progress DB Methods
export const playbackDB = {
  getProgress: (mediaId) => {
    return playbackCache.get(mediaId) || null;
  },

  saveProgress: (mediaId, currentTime, duration, completed = 0) => {
    const docData = {
      media_id: mediaId,
      current_time: currentTime,
      duration,
      completed: Boolean(completed),
      updated_at: new Date(),
    };

    playbackCache.set(mediaId, docData);

    PlaybackModel.findOneAndUpdate(
      { media_id: mediaId },
      { $set: docData },
      { upsert: true, returnDocument: 'after' }
    ).catch((err) => console.error('[Playback Save Error]:', err.message));
  },

  getContinueWatching: (limit = 15) => {
    const list = [];
    for (const [mediaId, progress] of playbackCache.entries()) {
      if (!progress.completed && progress.current_time > 10) {
        const media = mediaCache.get(mediaId);
        if (media) {
          list.push({
            ...media,
            current_time: progress.current_time,
            playback_duration: progress.duration,
            completed: progress.completed,
            last_watched: progress.updated_at,
          });
        }
      }
    }

    list.sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));
    return list.slice(0, limit);
  },
};

// Downloads DB Methods
export const downloadsDB = {
  getAll: () => {
    const list = Array.from(downloadCache.values());
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return list;
  },

  getById: (id) => {
    return downloadCache.get(id) || null;
  },

  upsert: (dl) => {
    const docData = {
      ...dl,
      updated_at: new Date(),
    };

    downloadCache.set(dl.id, docData);

    DownloadModel.findOneAndUpdate(
      { id: dl.id },
      { $set: docData },
      { upsert: true, returnDocument: 'after' }
    ).catch((err) => console.error('[Download Upsert Error]:', err.message));
  },

  delete: (id) => {
    downloadCache.delete(id);
    DownloadModel.deleteOne({ id }).catch((err) => console.error('[Download Delete Error]:', err.message));
  },

  deleteAsync: async (id) => {
    downloadCache.delete(id);
    await DownloadModel.deleteOne({ id }).catch((err) => console.error('[Download Delete Error]:', err.message));
  },
};

function safeJsonParse(str, fallback) {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch {
    return fallback;
  }
}

export default {
  initDatabase,
  mediaDB,
  playbackDB,
  downloadsDB,
};
