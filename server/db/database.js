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
import { heuristicParseFilename } from '../services/aiTagger.js';

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

const ProfileSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  avatar: { type: String, default: 'account_circle' },
  color: { type: String, default: '#e50914' },
  is_kids: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const WatchlistSchema = new mongoose.Schema({
  profile_id: { type: String, required: true, index: true },
  media_id: { type: String, required: true, index: true },
  added_at: { type: Date, default: Date.now },
});
WatchlistSchema.index({ profile_id: 1, media_id: 1 }, { unique: true });

const PlaybackSchema = new mongoose.Schema({
  profile_id: { type: String, required: true, default: 'default', index: true },
  media_id: { type: String, required: true, index: true },
  current_time: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  updated_at: { type: Date, default: Date.now },
});
PlaybackSchema.index({ profile_id: 1, media_id: 1 }, { unique: true });

const DownloadSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  source_type: String,
  source_url: String,
  status: { type: String, default: 'queued', index: true },
  status_text: String,
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
export const ProfileModel = mongoose.model('Profile', ProfileSchema);
export const WatchlistModel = mongoose.model('Watchlist', WatchlistSchema);

// In-Memory caches for high-speed synchronous retrieval
let mediaCache = new Map();
let playbackCache = new Map();
let downloadCache = new Map();
let profileCache = new Map();
let watchlistCache = new Map();
let lastMediaRefreshTime = 0;

export function normalizeSeriesKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function ensureMediaCacheFresh(force = false) {
  const now = Date.now();
  if (!force && now - lastMediaRefreshTime < 4000 && mediaCache.size > 0) {
    return;
  }
  await refreshCache();
}

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
    const autoVaultOps = [];
    allMedia.forEach((m) => {
      if (!m.is_adult) {
        const check = heuristicParseFilename(m.filename || m.gcs_path || '');
        if (check.is_adult) {
          m.is_adult = true;
          m.genres = ['Adult'];
          m.tags = ['Private', '18+'];
          m.plot = 'Private Media content.';
          autoVaultOps.push({
            updateOne: {
              filter: { id: m.id },
              update: {
                $set: {
                  is_adult: true,
                  genres: ['Adult'],
                  tags: ['Private', '18+'],
                  plot: 'Private Media content.',
                  updated_at: new Date(),
                },
              },
            },
          });
        }
      }
      mediaCache.set(m.id, m);
    });

    if (autoVaultOps.length > 0) {
      console.log(`[DB] Auto-vaulted ${autoVaultOps.length} leaked adult item(s) into Private Vault.`);
      await MediaModel.bulkWrite(autoVaultOps).catch((e) => console.warn('[DB Auto-Vault Error]:', e.message));
    }

    // Drop legacy single-field unique index on media_id if present to support multi-profile playback
    try {
      await PlaybackModel.collection.dropIndex('media_id_1');
    } catch (_) {}

    // Backfill legacy playback records with default profile_id
    await PlaybackModel.updateMany(
      { profile_id: { $exists: false } },
      { $set: { profile_id: 'default' } }
    ).catch(() => {});

    // Ensure initial default profile exists
    let defaultProfile = await ProfileModel.findOne({ id: 'default' });
    if (!defaultProfile) {
      const count = await ProfileModel.countDocuments();
      if (count === 0) {
        await ProfileModel.create({
          id: 'default',
          name: 'Owner',
          avatar: 'account_circle',
          color: '#e50914',
          is_kids: false,
        });
        console.log('[DB] Seeded initial default profile: "Owner"');
      }
    }

    const allProfiles = await ProfileModel.find({}).lean();
    profileCache.clear();
    allProfiles.forEach((p) => profileCache.set(p.id, p));

    const allWatchlists = await WatchlistModel.find({}).lean();
    watchlistCache.clear();
    allWatchlists.forEach((w) => {
      if (!watchlistCache.has(w.profile_id)) {
        watchlistCache.set(w.profile_id, new Set());
      }
      watchlistCache.get(w.profile_id).add(w.media_id);
    });

    const allPlayback = await PlaybackModel.find({}).lean();
    playbackCache.clear();
    allPlayback.forEach((p) => {
      const profId = p.profile_id || 'default';
      playbackCache.set(`${profId}:${p.media_id}`, p);
    });

    const allDownloads = await DownloadModel.find({}).sort({ created_at: -1 }).lean();
    downloadCache.clear();
    allDownloads.forEach((d) => downloadCache.set(d.id, d));

    lastMediaRefreshTime = Date.now();
    console.log(`[DB] Cache populated with ${mediaCache.size} media items and ${profileCache.size} profile(s) from MongoDB.`);
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

  upsert: async (item, allowVaultExit = false) => {
    const existing = mediaCache.get(item.id) || (item.gcs_path ? mediaDB.getByGcsPath(item.gcs_path) : null);
    const heuristicCheck = heuristicParseFilename(item.filename || item.gcs_path || '');
    const enforcedAdult = allowVaultExit
      ? Boolean(item.is_adult)
      : (heuristicCheck.is_adult ? true : Boolean(item.is_adult));

    const docData = {
      ...item,
      is_adult: enforcedAdult,
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

  getCanonicalSeriesName: (name) => {
    if (!name) return name;
    const key = normalizeSeriesKey(name);
    if (!key) return name;
    for (const item of mediaCache.values()) {
      if (item.type === 'series' && item.series_name) {
        if (normalizeSeriesKey(item.series_name) === key) {
          return item.series_name;
        }
      }
    }
    return name;
  },

  getSeriesInfo: (name) => {
    if (!name) return null;
    const key = normalizeSeriesKey(name);
    if (!key) return null;
    for (const item of mediaCache.values()) {
      if (item.type === 'series' && item.series_name) {
        if (normalizeSeriesKey(item.series_name) === key) {
          return {
            series_name: item.series_name,
            year: item.year,
            genres: item.genres,
            poster_url: item.poster_url,
            backdrop_url: item.backdrop_url,
          };
        }
      }
    }
    return null;
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

  getSeriesGrouped: (options = {}) => {
    const { search, limit = 100, isAdult = false } = options;
    const seriesMap = new Map();

    for (const item of mediaCache.values()) {
      if (item.type !== 'series') continue;
      if (!isAdult && item.is_adult) continue;
      if (isAdult && !item.is_adult) continue;

      const rawSeriesName = (item.series_name || item.title || 'Unknown').trim();
      const seriesKey = normalizeSeriesKey(rawSeriesName) || rawSeriesName.toLowerCase();

      if (!seriesMap.has(seriesKey)) {
        seriesMap.set(seriesKey, {
          id: `series-${encodeURIComponent(rawSeriesName.toLowerCase())}`,
          title: rawSeriesName,
          series_name: rawSeriesName,
          type: 'series',
          plot: item.plot,
          year: item.year,
          genres: item.genres || [],
          tags: item.tags || [],
          poster_url: item.poster_url,
          backdrop_url: item.backdrop_url,
          resolution: item.resolution,
          is_adult: Boolean(item.is_adult),
          created_at: item.created_at,
          seasons: new Set(),
          episodes_count: 0,
          sample_media_id: item.id,
        });
      }

      const s = seriesMap.get(seriesKey);
      s.episodes_count += 1;
      if (item.season) s.seasons.add(item.season);

      // Prefer canonical title with colon or longer formatted title if available
      if (rawSeriesName.includes(':') && !s.title.includes(':')) {
        s.title = rawSeriesName;
        s.series_name = rawSeriesName;
      }
      if (item.season === 1 && item.episode === 1 && item.plot) {
        s.plot = item.plot;
      } else if (item.plot && (!s.plot || s.plot.length < item.plot.length)) {
        s.plot = item.plot;
      }
      if (item.year && (!s.year || item.season === 1)) {
        s.year = item.year;
      }
      if (item.poster_url && !s.poster_url) s.poster_url = item.poster_url;
      if (item.backdrop_url && !s.backdrop_url) s.backdrop_url = item.backdrop_url;
      if (new Date(item.created_at) > new Date(s.created_at)) {
        s.created_at = item.created_at;
      }
    }

    let list = Array.from(seriesMap.values()).map((s) => ({
      ...s,
      seasons_count: Math.max(1, s.seasons.size),
      seasons_list: Array.from(s.seasons).sort((a, b) => a - b),
    }));

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        s.title.toLowerCase().includes(q) ||
        s.plot?.toLowerCase().includes(q) ||
        s.genres?.some((g) => g.toLowerCase().includes(q))
      );
    }

    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return list.slice(0, limit);
  },

  getSeriesSeasons: (seriesName, isAdult = false) => {
    const cleanName = (seriesName || '').trim().toLowerCase();
    const targetKey = normalizeSeriesKey(seriesName);
    const seasonsMap = {};
    let matchedSeries = null;

    for (const item of mediaCache.values()) {
      if (item.type !== 'series') continue;
      if (!isAdult && item.is_adult) continue;
      const curRaw = (item.series_name || item.title || '').trim().toLowerCase();
      const curKey = normalizeSeriesKey(curRaw);

      const matches = curKey === targetKey ||
                      curRaw === cleanName ||
                      (targetKey && curKey.includes(targetKey)) ||
                      (curKey && targetKey.includes(curKey)) ||
                      (cleanName && curRaw.includes(cleanName));

      if (!matches) continue;

      if (!matchedSeries || (item.series_name && item.series_name.includes(':') && !matchedSeries.series_name.includes(':'))) {
        matchedSeries = {
          series_name: item.series_name || item.title,
          title: item.series_name || item.title,
          plot: item.plot,
          year: item.year,
          genres: item.genres,
          poster_url: item.poster_url,
          backdrop_url: item.backdrop_url,
          is_adult: item.is_adult,
          sample_media_id: item.id,
        };
      }

      const sNum = item.season || 1;
      if (!seasonsMap[sNum]) {
        seasonsMap[sNum] = [];
      }
      seasonsMap[sNum].push(item);
    }

    for (const sNum in seasonsMap) {
      seasonsMap[sNum].sort((a, b) => (a.episode || 0) - (b.episode || 0));
    }

    return {
      series: matchedSeries,
      seasons: seasonsMap,
      seasonNumbers: Object.keys(seasonsMap).map(Number).sort((a, b) => a - b),
    };
  },
};

// Playback Progress DB Methods
export const playbackDB = {
  getProgress: (mediaId, profileId = 'default') => {
    return playbackCache.get(`${profileId}:${mediaId}`) || null;
  },

  saveProgress: (mediaId, currentTime, duration, completed = 0, profileId = 'default') => {
    const docData = {
      profile_id: profileId,
      media_id: mediaId,
      current_time: currentTime,
      duration,
      completed: Boolean(completed),
      updated_at: new Date(),
    };

    playbackCache.set(`${profileId}:${mediaId}`, docData);

    PlaybackModel.findOneAndUpdate(
      { profile_id: profileId, media_id: mediaId },
      { $set: docData },
      { upsert: true, returnDocument: 'after' }
    ).catch((err) => console.error('[Playback Save Error]:', err.message));
  },

  getContinueWatching: (profileId = 'default', limit = 15, allowAdult = false) => {
    const list = [];
    const prefix = `${profileId}:`;
    for (const [key, progress] of playbackCache.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (!progress.completed && progress.current_time > 10) {
        const media = mediaCache.get(progress.media_id);
        if (media) {
          if (media.is_adult && !allowAdult) {
            continue; // Strictly hide private/adult titles unless vault is open
          }
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

// Profiles & Watchlist DB Methods
export const profilesDB = {
  getAll: () => {
    const list = Array.from(profileCache.values());
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return list;
  },

  getById: (id) => {
    return profileCache.get(id) || null;
  },

  create: async (data) => {
    const id = data.id || `prof_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const profile = {
      id,
      name: (data.name || 'New Profile').trim(),
      avatar: data.avatar || 'account_circle',
      color: data.color || '#e50914',
      is_kids: Boolean(data.is_kids),
      created_at: new Date(),
      updated_at: new Date(),
    };
    profileCache.set(id, profile);
    await ProfileModel.create(profile);
    return profile;
  },

  update: async (id, data) => {
    const existing = profileCache.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      name: data.name !== undefined ? data.name.trim() : existing.name,
      avatar: data.avatar !== undefined ? data.avatar : existing.avatar,
      color: data.color !== undefined ? data.color : existing.color,
      is_kids: data.is_kids !== undefined ? Boolean(data.is_kids) : existing.is_kids,
      updated_at: new Date(),
    };
    profileCache.set(id, updated);
    await ProfileModel.findOneAndUpdate({ id }, { $set: updated });
    return updated;
  },

  delete: async (id) => {
    if (profileCache.size <= 1) {
      throw new Error('Cannot delete the only remaining profile');
    }
    profileCache.delete(id);
    watchlistCache.delete(id);
    const prefix = `${id}:`;
    for (const key of playbackCache.keys()) {
      if (key.startsWith(prefix)) playbackCache.delete(key);
    }
    await ProfileModel.deleteOne({ id });
    await PlaybackModel.deleteMany({ profile_id: id });
    await WatchlistModel.deleteMany({ profile_id: id });
    return true;
  },

  getWatchlist: (profileId = 'default', allowAdult = false) => {
    const ids = watchlistCache.get(profileId);
    if (!ids || ids.size === 0) return [];
    const list = [];
    for (const mediaId of ids) {
      const media = mediaCache.get(mediaId);
      if (media) {
        if (media.is_adult && !allowAdult) continue;
        list.push(media);
      }
    }
    return list;
  },

  toggleWatchlist: async (profileId = 'default', mediaId) => {
    if (!watchlistCache.has(profileId)) {
      watchlistCache.set(profileId, new Set());
    }
    const set = watchlistCache.get(profileId);
    const has = set.has(mediaId);
    if (has) {
      set.delete(mediaId);
      await WatchlistModel.deleteOne({ profile_id: profileId, media_id: mediaId });
      return { inWatchlist: false };
    } else {
      set.add(mediaId);
      await WatchlistModel.create({ profile_id: profileId, media_id: mediaId });
      return { inWatchlist: true };
    }
  },

  isInWatchlist: (profileId = 'default', mediaId) => {
    const set = watchlistCache.get(profileId);
    return set ? set.has(mediaId) : false;
  },
};

// Downloads DB Methods
export const downloadsDB = {
  getAll: () => {
    const list = Array.from(downloadCache.values());
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return list;
  },

  getAllAsync: async () => {
    try {
      const docs = await DownloadModel.find({}).sort({ created_at: -1 }).lean();
      downloadCache.clear();
      docs.forEach((d) => downloadCache.set(d.id, d));
      return docs;
    } catch (_) {
      return downloadsDB.getAll();
    }
  },

  getById: (id) => {
    return downloadCache.get(id) || null;
  },

  getByIdAsync: async (id) => {
    try {
      const doc = await DownloadModel.findOne({ id }).lean();
      if (doc) {
        downloadCache.set(id, doc);
        return doc;
      }
    } catch (_) {}
    return downloadCache.get(id) || null;
  },

  upsert: (dl) => {
    // Strip runtime stream & torrent instances that cannot be serialized to MongoDB
    const { torrent, currentReadStream, currentWriteStream, ...cleanData } = dl;
    const docData = {
      ...cleanData,
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
  profilesDB,
  downloadsDB,
};
