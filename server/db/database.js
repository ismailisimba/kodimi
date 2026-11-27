import dns from 'node:dns';
// Resolve DNS SRV lookups reliably across platforms
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/env.js';
import { heuristicParseFilename, isPlaceholderOrGenericPlot } from '../services/aiTagger.js';

export const MAX_PASSCODE_BYTES = 72;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // 24-hour automatic fallback
export const ATTEMPT_WINDOW_MS = 30 * 60 * 1000; // 30-min rolling decay for <5 failed attempts
export const MAX_RESET_REQUESTS_PER_LOCKOUT = 3;

export function normalizePasscode(plainCode) {
  return String(plainCode ?? '').trim();
}

export function computePasscodeFingerprint(plainCode) {
  const normalized = normalizePasscode(plainCode);
  if (!normalized) return null;
  return crypto
    .createHmac('sha256', String(config.jwtSecret || 'kodimi_default_dev_secret_key_2026'))
    .update(normalized)
    .digest('hex');
}

export function normalizeClientKey(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  return raw.replace(/^::ffff:/, '');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Mongoose Schemas & Models
// ==========================================

const CustomSubtitleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    language: { type: String, default: 'und' },
    gcs_path: { type: String, required: true },
    format: { type: String, default: 'vtt' },
    created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

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
  series_plot: String,
  genres: [String],
  tags: [String],
  poster_url: String,
  backdrop_url: String,
  duration: { type: Number, default: 0 },
  size_bytes: { type: Number, default: 0 },
  bitrate_kbps: { type: Number, default: 0 },
  resolution: String,
  video_codec: String,
  audio_codec: String,
  custom_subtitles: { type: [CustomSubtitleSchema], default: [] },
  is_adult: { type: Boolean, default: false },
  gcs_created_at: { type: Date, index: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const ProfileSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  avatar: { type: String, default: 'account_circle' },
  color: { type: String, default: '#e50914' },
  is_kids: { type: Boolean, default: false },
  role: { type: String, enum: ['owner', 'member'], default: 'member' },
  passcode_hash: { type: String, default: null },
  passcode_fingerprint: { type: String, default: undefined },
  passcode_version: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});
ProfileSchema.index(
  { passcode_fingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { passcode_fingerprint: { $type: 'string' } },
  }
);

const AuthLockoutSchema = new mongoose.Schema({
  client_key: { type: String, required: true, unique: true, index: true },
  failed_attempts: { type: Number, default: 0 },
  locked: { type: Boolean, default: false },
  locked_at: { type: Date, default: null },
  expires_at: { type: Date, default: null },
  last_attempt_at: { type: Date, default: Date.now },
  reset_request_count: { type: Number, default: 0 },
});

const ResetRequestSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  requested_name: { type: String, required: true },
  matched_profile_id: { type: String, default: null },
  matched_profile_name: { type: String, default: null },
  client_ip: { type: String, required: true, index: true },
  failed_attempts: { type: Number, default: MAX_LOGIN_ATTEMPTS },
  status: { type: String, enum: ['pending', 'resolved', 'dismissed'], default: 'pending', index: true },
  resolution_note: { type: String, default: null },
  resolved_profile_id: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true },
  resolved_at: { type: Date, default: null },
});

const IptvHealthSchema = new mongoose.Schema({
  channel_id: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['verified', 'offline', 'unknown'], default: 'unknown' },
  latency_ms: { type: Number, default: 0 },
  fail_count: { type: Number, default: 0 },
  last_error: { type: String, default: null },
  stream_url: { type: String, default: null },
  checked_at: { type: Date, default: Date.now, expires: 21600 }, // 6h TTL
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
  category: String,
  include_playlist: { type: Boolean, default: false },
  max_items: { type: Number, default: 50 },
  auto_resume_count: { type: Number, default: 0 },
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
export const IptvHealthModel = mongoose.model('IptvHealth', IptvHealthSchema);
export const AuthLockoutModel = mongoose.model('AuthLockout', AuthLockoutSchema);
export const ResetRequestModel = mongoose.model('ResetRequest', ResetRequestSchema);

export function sanitizeProfile(profile) {
  if (!profile) return null;
  const { passcode_hash, passcode_fingerprint, _id, __v, ...rest } = profile;
  return {
    ...rest,
    role: rest.role || (rest.id === 'default' ? 'owner' : 'member'),
    has_passcode: Boolean(passcode_hash),
    passcode_version: Number(rest.passcode_version || 0),
  };
}

// In-Memory caches for high-speed synchronous retrieval
let mediaCache = new Map();
let playbackCache = new Map();
let downloadCache = new Map();
let profileCache = new Map();
let watchlistCache = new Map();
let lockoutCache = new Map();
let resetRequestCache = new Map();
let lastMediaRefreshTime = 0;
let lastProfilesRefreshTime = 0;

export function normalizeSeriesKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function toValidDate(val) {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function getEffectiveAddedTime(item) {
  if (!item) return 0;
  const d =
    toValidDate(item.gcs_created_at) ||
    toValidDate(item.created_at) ||
    toValidDate(item.updated_at);
  return d ? d.getTime() : 0;
}

function isGenericFallbackPlot(text) {
  return isPlaceholderOrGenericPlot(text);
}

export async function ensureMediaCacheFresh(force = false) {
  const now = Date.now();
  if (!force && now - lastMediaRefreshTime < 4000 && mediaCache.size > 0) {
    return;
  }
  await refreshCache();
}

export async function ensureProfilesFresh(force = false) {
  if (mongoose.connection.readyState !== 1) return;
  const now = Date.now();
  if (!force && now - lastProfilesRefreshTime < 2000 && profileCache.size > 0) {
    return;
  }
  try {
    const allProfiles = await ProfileModel.find({}).lean();
    profileCache.clear();
    allProfiles.forEach((p) => profileCache.set(p.id, p));
    lastProfilesRefreshTime = Date.now();
  } catch (err) {
    console.warn('[DB] Profile cache refresh warning:', err.message);
  }
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

    // Ensure initial default Owner profile exists and has migrated role + hashed passcode + fingerprint
    const adminPasswordClean = normalizePasscode(config.adminPassword || 'kodimi123');
    const isAdminPreHashed = Boolean(config.adminPassword?.startsWith('$2'));
    const defaultPasscodeHash = isAdminPreHashed
      ? config.adminPassword
      : bcrypt.hashSync(adminPasswordClean, 10);
    const defaultPasscodeFingerprint = isAdminPreHashed
      ? undefined
      : computePasscodeFingerprint(adminPasswordClean);

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
          role: 'owner',
          passcode_hash: defaultPasscodeHash,
          ...(defaultPasscodeFingerprint ? { passcode_fingerprint: defaultPasscodeFingerprint } : {}),
          passcode_version: 0,
        });
        console.log('[DB] Seeded initial default Owner profile with hashed login code.');
      }
    } else if (!defaultProfile.passcode_hash || defaultProfile.role !== 'owner') {
      const patch = {
        role: 'owner',
        updated_at: new Date(),
      };
      if (!defaultProfile.passcode_hash) {
        patch.passcode_hash = defaultPasscodeHash;
        if (defaultPasscodeFingerprint) {
          const conflicting = await ProfileModel.findOne({
            id: { $ne: 'default' },
            passcode_fingerprint: defaultPasscodeFingerprint,
          }).lean();
          if (!conflicting) {
            patch.passcode_fingerprint = defaultPasscodeFingerprint;
          }
        }
      }
      await ProfileModel.updateOne({ id: 'default' }, { $set: patch });
      console.log('[DB] Migrated Owner profile to per-profile authentication.');
    } else if (
      !defaultProfile.passcode_fingerprint &&
      defaultPasscodeFingerprint &&
      bcrypt.compareSync(adminPasswordClean, defaultProfile.passcode_hash)
    ) {
      const conflicting = await ProfileModel.findOne({
        id: { $ne: 'default' },
        passcode_fingerprint: defaultPasscodeFingerprint,
      }).lean();
      if (!conflicting) {
        await ProfileModel.updateOne(
          { id: 'default' },
          { $set: { passcode_fingerprint: defaultPasscodeFingerprint } }
        ).catch(() => {});
      }
    }

    // Backfill member role on any legacy non-owner profiles
    await ProfileModel.updateMany(
      { id: { $ne: 'default' }, role: { $exists: false } },
      { $set: { role: 'member' } }
    ).catch(() => {});

    const allProfiles = await ProfileModel.find({}).lean();
    profileCache.clear();
    allProfiles.forEach((p) => profileCache.set(p.id, p));
    lastProfilesRefreshTime = Date.now();

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
    const { type, genre, search, limit = 500, offset = 0, isAdult = false, sort = 'recent' } = options;
    let list = Array.from(mediaCache.values());

    if (!isAdult) {
      list = list.filter((m) => !m.is_adult);
    } else {
      list = list.filter((m) => Boolean(m.is_adult));
    }

    if (type) {
      const normType = String(type).toLowerCase().trim();
      if (normType === 'documentary') {
        list = list.filter(
          (m) =>
            m.type === 'documentary' ||
            (Array.isArray(m.genres) && m.genres.some((g) => String(g).toLowerCase() === 'documentary')) ||
            (Array.isArray(m.tags) && m.tags.some((t) => String(t).toLowerCase() === 'documentary'))
        );
      } else if (normType === 'others') {
        list = list.filter(
          (m) =>
            m.type === 'others' ||
            (Array.isArray(m.tags) && m.tags.some((t) => String(t).toLowerCase() === 'others'))
        );
      } else {
        list = list.filter((m) => m.type === normType);
      }
    }

    if (genre) {
      list = list.filter((m) => m.genres && m.genres.includes(genre));
    }

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((m) => {
        const inTitle = m.title?.toLowerCase().includes(q);
        const inSeries = m.series_name?.toLowerCase().includes(q);
        const inPlot = m.plot?.toLowerCase().includes(q) || m.series_plot?.toLowerCase().includes(q);
        const inTags = m.tags?.some((t) => t.toLowerCase().includes(q));
        return inTitle || inSeries || inPlot || inTags;
      });
    }

    if (sort === 'year') {
      list.sort(
        (a, b) =>
          (b.year || 0) - (a.year || 0) ||
          getEffectiveAddedTime(b) - getEffectiveAddedTime(a) ||
          (a.title || '').localeCompare(b.title || '')
      );
    } else if (sort === 'title') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else {
      // Sort newest first using NaN-safe authoritative GCS upload time -> created_at -> updated_at
      list.sort(
        (a, b) =>
          getEffectiveAddedTime(b) - getEffectiveAddedTime(a) ||
          (a.title || '').localeCompare(b.title || '')
      );
    }

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

    const resolvedGcsCreated =
      toValidDate(item.gcs_created_at) ||
      toValidDate(existing?.gcs_created_at) ||
      null;
    const resolvedCreated =
      toValidDate(item.created_at) ||
      toValidDate(existing?.created_at) ||
      resolvedGcsCreated ||
      new Date();

    const docData = {
      ...(existing || {}),
      ...item,
      series_plot: item.series_plot || existing?.series_plot || undefined,
      duration: item.duration > 0 ? item.duration : (existing?.duration || 0),
      bitrate_kbps: item.bitrate_kbps > 0 ? item.bitrate_kbps : (existing?.bitrate_kbps || 0),
      custom_subtitles: Array.isArray(item.custom_subtitles)
        ? item.custom_subtitles
        : (existing?.custom_subtitles || []),
      is_adult: enforcedAdult,
      gcs_created_at: resolvedGcsCreated,
      created_at: resolvedCreated,
      updated_at: new Date(),
    };

    // Update in-memory cache immediately
    mediaCache.set(item.id, docData);

    // Persist to MongoDB when connected
    if (mongoose.connection.readyState === 1) {
      try {
        await MediaModel.findOneAndUpdate(
          { gcs_path: item.gcs_path },
          { $set: docData },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (err) {
        console.error('[DB Upsert Error]:', err.message);
      }
    }

    return docData;
  },

  delete: async (id) => {
    mediaCache.delete(id);
    if (mongoose.connection.readyState === 1) {
      await MediaModel.deleteOne({ id }).catch((err) => console.error('[DB Delete Error]:', err.message));
    }
  },

  updateCategory: async (id, category) => {
    const existing = mediaCache.get(id);
    if (!existing) return null;
    const cat = String(category || '').toLowerCase().trim();
    const allowed = new Set(['movie', 'series', 'documentary', 'others']);
    if (!allowed.has(cat)) {
      throw new Error('Invalid category. Allowed: movie, series, documentary, others');
    }

    let genres = Array.isArray(existing.genres) ? [...existing.genres] : [];
    let tags = Array.isArray(existing.tags) ? [...existing.tags] : [];

    const addUnique = (arr, val) => {
      if (!arr.some((x) => String(x).toLowerCase() === val.toLowerCase())) arr.push(val);
    };
    const removeCI = (arr, val) => arr.filter((x) => String(x).toLowerCase() !== val.toLowerCase());

    let nextType = cat;
    if (cat === 'documentary') {
      addUnique(genres, 'Documentary');
      addUnique(tags, 'Documentary');
      genres = removeCI(genres, 'Others');
      tags = removeCI(tags, 'Others');
      nextType = 'documentary';
    } else if (cat === 'others') {
      addUnique(tags, 'Others');
      genres = removeCI(genres, 'Documentary');
      tags = removeCI(tags, 'Documentary');
      if (genres.length === 0) genres = ['Others'];
      nextType = 'others';
    } else if (cat === 'movie') {
      genres = removeCI(genres, 'Documentary');
      genres = removeCI(genres, 'Others');
      tags = removeCI(tags, 'Documentary');
      tags = removeCI(tags, 'Others');
      nextType = 'movie';
    } else if (cat === 'series') {
      genres = removeCI(genres, 'Documentary');
      genres = removeCI(genres, 'Others');
      tags = removeCI(tags, 'Documentary');
      tags = removeCI(tags, 'Others');
      nextType = 'series';
    }

    const preserveSeriesName =
      Boolean(existing.series_name) &&
      (nextType === 'series' ||
        nextType === 'documentary' ||
        nextType === 'others') &&
      (existing.season != null ||
        existing.episode != null ||
        tags.some((t) => String(t).toLowerCase() === 'playlist'));

    return mediaDB.upsert(
      {
        ...existing,
        type: nextType,
        series_name: nextType === 'series'
          ? (existing.series_name || existing.title)
          : preserveSeriesName
            ? existing.series_name
            : null,
        season: nextType === 'movie' ? null : existing.season,
        episode: nextType === 'movie' ? null : existing.episode,
        genres,
        tags,
      },
      true
    );
  },

  updateTags: async (id, { addTags = [], removeTags = [], addGenres = [], removeGenres = [] } = {}) => {
    const existing = mediaCache.get(id);
    if (!existing) return null;

    const cleanList = (arr) =>
      (Array.isArray(arr) ? arr : [arr])
        .map((v) => String(v || '').trim().replace(/^#+/, '').slice(0, 40))
        .filter(Boolean);

    const toAddTags = cleanList(addTags);
    const toRemoveTags = cleanList(removeTags).map((s) => s.toLowerCase());
    const toAddGenres = cleanList(addGenres);
    const toRemoveGenres = cleanList(removeGenres).map((s) => s.toLowerCase());

    let tags = Array.isArray(existing.tags) ? [...existing.tags] : [];
    let genres = Array.isArray(existing.genres) ? [...existing.genres] : [];

    if (toRemoveTags.length > 0) {
      tags = tags.filter((t) => !toRemoveTags.includes(String(t).toLowerCase()));
    }
    for (const t of toAddTags) {
      if (!tags.some((x) => String(x).toLowerCase() === t.toLowerCase())) {
        tags.push(t);
      }
    }

    if (toRemoveGenres.length > 0) {
      genres = genres.filter((g) => !toRemoveGenres.includes(String(g).toLowerCase()));
    }
    for (const g of toAddGenres) {
      if (!genres.some((x) => String(x).toLowerCase() === g.toLowerCase())) {
        genres.push(g);
      }
    }

    return mediaDB.upsert(
      {
        ...existing,
        tags,
        genres,
      },
      true
    );
  },

  findSeriesItems: (seriesName, isAdult = false) => {
    const cleanName = (seriesName || '').trim().toLowerCase();
    const targetKey = normalizeSeriesKey(seriesName);
    if (!cleanName && !targetKey) return [];

    const matched = [];
    for (const item of mediaCache.values()) {
      if (item.type !== 'series' && !item.series_name) continue;
      if (!isAdult && item.is_adult) continue;
      if (isAdult && !item.is_adult) continue;
      const curRaw = (item.series_name || item.title || '').trim().toLowerCase();
      const curKey = normalizeSeriesKey(curRaw);
      if (curKey === targetKey || curRaw === cleanName) {
        matched.push(item);
      }
    }
    return matched;
  },

  updateSeriesCategory: async (seriesName, category, isAdult = false) => {
    const items = mediaDB.findSeriesItems(seriesName, isAdult);
    if (items.length === 0) return null;

    const updatedItems = [];
    for (const ep of items) {
      const updated = await mediaDB.updateCategory(ep.id, category);
      if (updated) updatedItems.push(updated);
    }
    return {
      seriesName: updatedItems[0]?.series_name || seriesName,
      category: String(category).toLowerCase().trim(),
      updatedCount: updatedItems.length,
      items: updatedItems,
    };
  },

  updateSeriesTags: async (seriesName, payload = {}, isAdult = false) => {
    const items = mediaDB.findSeriesItems(seriesName, isAdult);
    if (items.length === 0) return null;

    const updatedItems = [];
    for (const ep of items) {
      const updated = await mediaDB.updateTags(ep.id, payload);
      if (updated) updatedItems.push(updated);
    }
    return {
      seriesName: updatedItems[0]?.series_name || seriesName,
      updatedCount: updatedItems.length,
      items: updatedItems,
    };
  },

  getCanonicalSeriesName: (name) => {
    if (!name) return name;
    const key = normalizeSeriesKey(name);
    if (!key) return name;
    for (const item of mediaCache.values()) {
      if ((item.type === 'series' || item.series_name) && item.series_name) {
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
    let info = null;
    for (const item of mediaCache.values()) {
      if ((item.type === 'series' || item.series_name) && item.series_name && normalizeSeriesKey(item.series_name) === key) {
        if (!info) {
          info = {
            series_name: item.series_name,
            year: item.year || null,
            series_plot: !isGenericFallbackPlot(item.series_plot) ? item.series_plot : null,
            genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : null,
            poster_url: item.poster_url || null,
            backdrop_url: item.backdrop_url || null,
          };
        } else {
          if (item.series_name.includes(':') && !info.series_name.includes(':')) {
            info.series_name = item.series_name;
          }
          if (!info.year && item.year) info.year = item.year;
          if (!info.series_plot && !isGenericFallbackPlot(item.series_plot)) {
            info.series_plot = item.series_plot;
          }
          if (!info.genres && Array.isArray(item.genres) && item.genres.length > 0) {
            info.genres = item.genres;
          }
          if (!info.poster_url && item.poster_url) info.poster_url = item.poster_url;
          if (!info.backdrop_url && item.backdrop_url) info.backdrop_url = item.backdrop_url;
        }
      }
    }
    return info;
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
      const itemAddedTs = getEffectiveAddedTime(item);

      const itemIsPlaylist =
        Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase() === 'playlist');

      if (!seriesMap.has(seriesKey)) {
        const initialSeriesPlot = !isGenericFallbackPlot(item.series_plot) ? item.series_plot : null;
        seriesMap.set(seriesKey, {
          id: `series-${encodeURIComponent(rawSeriesName.toLowerCase())}`,
          title: rawSeriesName,
          series_name: rawSeriesName,
          type: 'series',
          is_series_group: true,
          is_playlist: itemIsPlaylist,
          series_plot: initialSeriesPlot,
          plot: initialSeriesPlot || item.plot,
          year: item.year,
          genres: item.genres || [],
          tags: item.tags || [],
          poster_url: item.poster_url,
          backdrop_url: item.backdrop_url,
          resolution: item.resolution,
          is_adult: Boolean(item.is_adult),
          gcs_created_at: item.gcs_created_at || null,
          created_at: item.created_at || null,
          _added_ts: itemAddedTs,
          seasons: new Set(),
          episodes_count: 0,
          sample_media_id: item.id,
        });
      }

      const s = seriesMap.get(seriesKey);
      s.episodes_count += 1;
      if (item.season) s.seasons.add(item.season);
      if (itemIsPlaylist) s.is_playlist = true;
      if (item.season === 1 && item.episode === 1) s.sample_media_id = item.id;

      // Prefer canonical title with colon or longer formatted title if available
      if (rawSeriesName.includes(':') && !s.title.includes(':')) {
        s.title = rawSeriesName;
        s.series_name = rawSeriesName;
      }

      // Series overview synopsis priority: dedicated series_plot -> S01E01 plot -> longest non-generic plot
      if (!isGenericFallbackPlot(item.series_plot)) {
        if (!s.series_plot || item.series_plot.length > s.series_plot.length) {
          s.series_plot = item.series_plot;
          s.plot = item.series_plot;
        }
      } else if (!s.series_plot) {
        if (item.season === 1 && item.episode === 1 && item.plot && !isGenericFallbackPlot(item.plot)) {
          s.plot = item.plot;
        } else if (
          item.plot &&
          (!s.plot ||
            (isGenericFallbackPlot(s.plot) && !isGenericFallbackPlot(item.plot)) ||
            (!isGenericFallbackPlot(item.plot) && item.plot.length > s.plot.length))
        ) {
          s.plot = item.plot;
        }
      }

      if (item.year && (!s.year || item.season === 1)) {
        s.year = item.year;
      }
      if (item.poster_url && !s.poster_url) s.poster_url = item.poster_url;
      if (item.backdrop_url && !s.backdrop_url) s.backdrop_url = item.backdrop_url;
      if (itemAddedTs > s._added_ts) {
        s._added_ts = itemAddedTs;
        if (item.gcs_created_at) s.gcs_created_at = item.gcs_created_at;
        if (item.created_at) s.created_at = item.created_at;
      }
    }

    let list = Array.from(seriesMap.values()).map(({ seasons, _added_ts, ...s }) => ({
      ...s,
      added_timestamp: _added_ts,
      seasons_count: Math.max(1, seasons.size),
      seasons_list: Array.from(seasons).sort((a, b) => a - b),
    }));

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.plot?.toLowerCase().includes(q) ||
          s.series_plot?.toLowerCase().includes(q) ||
          s.genres?.some((g) => g.toLowerCase().includes(q))
      );
    }

    list.sort(
      (a, b) =>
        b.added_timestamp - a.added_timestamp ||
        (a.title || '').localeCompare(b.title || '')
    );
    return list.slice(0, limit);
  },

  getSeriesSeasons: (seriesName, isAdult = false, profileId = null) => {
    const cleanName = (seriesName || '').trim().toLowerCase();
    const targetKey = normalizeSeriesKey(seriesName);
    const seasonsMap = {};
    let matchedSeries = null;

    for (const item of mediaCache.values()) {
      if (item.type !== 'series' && !item.series_name) continue;
      if (!isAdult && item.is_adult) continue;
      const curRaw = (item.series_name || item.title || '').trim().toLowerCase();
      const curKey = normalizeSeriesKey(curRaw);

      const matches =
        curKey === targetKey ||
        curRaw === cleanName ||
        (targetKey && curKey.includes(targetKey)) ||
        (curKey && targetKey.includes(curKey)) ||
        (cleanName && curRaw.includes(cleanName));

      if (!matches) continue;

      const itemIsPlaylist =
        Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase() === 'playlist');

      if (!matchedSeries) {
        const initialSeriesPlot = !isGenericFallbackPlot(item.series_plot) ? item.series_plot : null;
        matchedSeries = {
          series_name: item.series_name || item.title,
          title: item.series_name || item.title,
          type: item.type || 'series',
          is_playlist: itemIsPlaylist,
          tags: Array.isArray(item.tags) ? [...item.tags] : [],
          series_plot: initialSeriesPlot,
          plot: initialSeriesPlot || item.plot,
          year: item.year,
          genres: Array.isArray(item.genres) ? [...item.genres] : [],
          poster_url: item.poster_url,
          backdrop_url: item.backdrop_url,
          is_adult: item.is_adult,
          sample_media_id: item.id,
        };
      } else {
        if (itemIsPlaylist) matchedSeries.is_playlist = true;
        if (item.season === 1 && item.episode === 1) {
          matchedSeries.sample_media_id = item.id;
        }
        if (item.series_name && item.series_name.includes(':') && !matchedSeries.series_name.includes(':')) {
          matchedSeries.series_name = item.series_name;
          matchedSeries.title = item.series_name;
        }
        if (!isGenericFallbackPlot(item.series_plot)) {
          if (!matchedSeries.series_plot || item.series_plot.length > matchedSeries.series_plot.length) {
            matchedSeries.series_plot = item.series_plot;
            matchedSeries.plot = item.series_plot;
          }
        } else if (!matchedSeries.series_plot) {
          if (item.season === 1 && item.episode === 1 && item.plot && !isGenericFallbackPlot(item.plot)) {
            matchedSeries.plot = item.plot;
          } else if (
            item.plot &&
            (!matchedSeries.plot ||
              (isGenericFallbackPlot(matchedSeries.plot) && !isGenericFallbackPlot(item.plot)))
          ) {
            matchedSeries.plot = item.plot;
          }
        }
        if (!matchedSeries.year && item.year) matchedSeries.year = item.year;
        if (Array.isArray(item.genres)) {
          for (const g of item.genres) {
            if (g && !matchedSeries.genres.some((x) => String(x).toLowerCase() === String(g).toLowerCase())) {
              matchedSeries.genres.push(g);
            }
          }
        }
        if (Array.isArray(item.tags)) {
          for (const t of item.tags) {
            if (t && !matchedSeries.tags.some((x) => String(x).toLowerCase() === String(t).toLowerCase())) {
              matchedSeries.tags.push(t);
            }
          }
        }
        if (!matchedSeries.poster_url && item.poster_url) matchedSeries.poster_url = item.poster_url;
        if (!matchedSeries.backdrop_url && item.backdrop_url) matchedSeries.backdrop_url = item.backdrop_url;
      }

      const sNum = item.season || 1;
      if (!seasonsMap[sNum]) {
        seasonsMap[sNum] = [];
      }
      const prog = profileId ? playbackCache.get(`${profileId}:${item.id}`) : null;
      const effDur = prog?.duration || item.duration || 0;
      const epDone = prog ? isPlaybackCompleted(prog.current_time, effDur, prog.completed) : false;
      seasonsMap[sNum].push(
        prog
          ? {
              ...item,
              current_time: epDone ? 0 : prog.current_time,
              playback_duration: effDur,
              completed: epDone,
            }
          : item
      );
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

/**
 * Determines whether a VOD playback session should be treated as finished
 * (e.g. reached end credits >= 92% of total duration or explicitly ended).
 */
export function isPlaybackCompleted(currentTime, duration, completedFlag = false) {
  if (Boolean(completedFlag)) return true;
  const cur = Number(currentTime) || 0;
  const dur = Number(duration) || 0;
  if (dur > 60 && cur / dur >= 0.92) return true;
  if (dur > 0 && dur <= 60 && cur / dur >= 0.95) return true;
  return false;
}

// Playback Progress DB Methods
export const playbackDB = {
  getProgress: (mediaId, profileId = 'default') => {
    return playbackCache.get(`${profileId}:${mediaId}`) || null;
  },

  saveProgress: async (mediaId, currentTime, duration, completed = 0, profileId = 'default') => {
    const media = mediaCache.get(mediaId);
    const effectiveDuration = Number(duration) > 0 ? Number(duration) : (media?.duration || 0);
    const safeCurrent = Math.max(0, Number(currentTime) || 0);
    const isCompleted = isPlaybackCompleted(safeCurrent, effectiveDuration, completed);

    const docData = {
      profile_id: profileId,
      media_id: mediaId,
      current_time: safeCurrent,
      duration: effectiveDuration,
      completed: isCompleted,
      updated_at: new Date(),
    };

    playbackCache.set(`${profileId}:${mediaId}`, docData);

    if (mongoose.connection.readyState === 1) {
      try {
        await PlaybackModel.findOneAndUpdate(
          { profile_id: profileId, media_id: mediaId },
          { $set: docData },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (err) {
        console.error('[Playback Save Error]:', err.message);
      }
    }

    return docData;
  },

  markCompleted: async (mediaId, profileId = 'default') => {
    const existing = playbackCache.get(`${profileId}:${mediaId}`);
    const media = mediaCache.get(mediaId);
    const effectiveDuration = existing?.duration || media?.duration || 0;
    const docData = {
      profile_id: profileId,
      media_id: mediaId,
      current_time: effectiveDuration,
      duration: effectiveDuration,
      completed: true,
      updated_at: new Date(),
    };

    playbackCache.set(`${profileId}:${mediaId}`, docData);

    if (mongoose.connection.readyState === 1) {
      try {
        await PlaybackModel.findOneAndUpdate(
          { profile_id: profileId, media_id: mediaId },
          { $set: docData },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (err) {
        console.error('[Playback MarkCompleted Error]:', err.message);
      }
    }

    return docData;
  },

  deleteProgress: async (mediaId, profileId = 'default') => {
    playbackCache.delete(`${profileId}:${mediaId}`);
    if (mongoose.connection.readyState === 1) {
      await PlaybackModel.deleteOne({ profile_id: profileId, media_id: mediaId }).catch((err) =>
        console.error('[Playback Delete Error]:', err.message)
      );
    }
  },

  getContinueWatching: (profileId = 'default', limit = 15, allowAdult = false) => {
    const list = [];
    const prefix = `${profileId}:`;
    for (const [key, progress] of playbackCache.entries()) {
      if (!key.startsWith(prefix)) continue;
      const media = mediaCache.get(progress.media_id);
      if (!media) continue;
      const effDur = progress.duration || media.duration || 0;
      if (!isPlaybackCompleted(progress.current_time, effDur, progress.completed) && progress.current_time > 10) {
        if (media.is_adult && !allowAdult) {
          continue; // Strictly hide private/adult titles unless vault is open
        }
        list.push({
          ...media,
          current_time: progress.current_time,
          playback_duration: effDur,
          completed: false,
          last_watched: progress.updated_at,
        });
      }
    }

    list.sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));
    return list.slice(0, limit);
  },
};

// Profiles & Watchlist DB Methods
const PASSCODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateUniquePasscode() {
  for (let attempt = 0; attempt < 24; attempt++) {
    const bytes = crypto.randomBytes(8);
    let raw = '';
    for (let i = 0; i < 8; i++) {
      raw += PASSCODE_ALPHABET[bytes[i] % PASSCODE_ALPHABET.length];
    }
    const candidate = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!profilesDB.isPasscodeInUse(candidate)) {
      return candidate;
    }
  }
  const fallback = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${fallback.slice(0, 4)}-${fallback.slice(4, 8)}-${fallback.slice(8)}`;
}

function createDuplicatePasscodeError() {
  const err = new Error('That login code is already used by another profile. Please choose a unique code.');
  err.statusCode = 409;
  return err;
}

export const profilesDB = {
  getAll: () => {
    const list = Array.from(profileCache.values());
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return list.map(sanitizeProfile);
  },

  getAllRaw: () => {
    const list = Array.from(profileCache.values());
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return list;
  },

  getById: (id) => {
    return sanitizeProfile(profileCache.get(id) || null);
  },

  getRawById: (id) => {
    return profileCache.get(id) || null;
  },

  findByNameCaseInsensitive: (name) => {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    for (const p of profileCache.values()) {
      if (String(p.name || '').trim().toLowerCase() === target) {
        return p;
      }
    }
    return null;
  },

  isPasscodeInUse: (plainCode, excludeProfileId = null) => {
    const candidate = normalizePasscode(plainCode);
    if (!candidate) return false;
    const candidateFp = computePasscodeFingerprint(candidate);

    for (const p of profileCache.values()) {
      if (excludeProfileId && p.id === excludeProfileId) continue;

      if (p.passcode_fingerprint && candidateFp) {
        if (p.passcode_fingerprint === candidateFp) {
          return true;
        }
        continue;
      }

      if (p.passcode_hash) {
        try {
          if (bcrypt.compareSync(candidate, p.passcode_hash)) {
            return true;
          }
        } catch (_) {}
      } else if (p.id === 'default' || p.role === 'owner') {
        // Protect unmigrated Owner fallback password from being claimed by another profile
        const adminRaw = normalizePasscode(config.adminPassword || 'kodimi123');
        if (adminRaw) {
          if (candidate === adminRaw) return true;
          try {
            if (adminRaw.startsWith('$2') && bcrypt.compareSync(candidate, adminRaw)) {
              return true;
            }
          } catch (_) {}
        }
      }
    }
    return false;
  },

  backfillPasscodeFingerprint: async (id, plainCode) => {
    const existing = profileCache.get(id);
    if (!existing || existing.passcode_fingerprint) return;
    const fp = computePasscodeFingerprint(plainCode);
    if (!fp) return;
    if (profilesDB.isPasscodeInUse(plainCode, id)) return;

    const updated = { ...existing, passcode_fingerprint: fp };
    profileCache.set(id, updated);
    if (mongoose.connection.readyState === 1) {
      try {
        await ProfileModel.updateOne(
          { id, passcode_fingerprint: { $exists: false } },
          { $set: { passcode_fingerprint: fp } }
        );
      } catch (_) {
        // Ignore duplicate key races on lazy backfill
      }
    }
  },

  create: async (data) => {
    await ensureProfilesFresh(true);
    const id = data.id || `prof_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let passcodeHash = data.passcode_hash || null;
    let passcodeFingerprint;

    if (data.passcode !== undefined && data.passcode !== null && String(data.passcode).trim() !== '') {
      const cleanCode = normalizePasscode(data.passcode);
      if (cleanCode.length < 4) {
        const err = new Error('Login code must be at least 4 characters');
        err.statusCode = 400;
        throw err;
      }
      if (Buffer.byteLength(cleanCode, 'utf8') > MAX_PASSCODE_BYTES) {
        const err = new Error(`Login code must be ${MAX_PASSCODE_BYTES} characters or fewer`);
        err.statusCode = 400;
        throw err;
      }
      if (profilesDB.isPasscodeInUse(cleanCode)) {
        throw createDuplicatePasscodeError();
      }
      passcodeHash = bcrypt.hashSync(cleanCode, 10);
      passcodeFingerprint = computePasscodeFingerprint(cleanCode);
    }

    const role = data.role === 'owner' ? 'owner' : (id === 'default' ? 'owner' : 'member');
    const profile = {
      id,
      name: (data.name || 'New Profile').trim(),
      avatar: data.avatar || 'account_circle',
      color: data.color || '#e50914',
      is_kids: Boolean(data.is_kids),
      role,
      passcode_hash: passcodeHash,
      ...(passcodeFingerprint ? { passcode_fingerprint: passcodeFingerprint } : {}),
      passcode_version: Number(data.passcode_version || 0),
      created_at: new Date(),
      updated_at: new Date(),
    };

    if (mongoose.connection.readyState === 1) {
      try {
        await ProfileModel.create(profile);
      } catch (err) {
        if (err && err.code === 11000) {
          throw createDuplicatePasscodeError();
        }
        throw err;
      }
    }
    profileCache.set(id, profile);
    return sanitizeProfile(profile);
  },

  update: async (id, data) => {
    await ensureProfilesFresh(true);
    const existing = profileCache.get(id);
    if (!existing) return null;

    let nextPasscodeHash = existing.passcode_hash || null;
    let nextPasscodeFingerprint = existing.passcode_fingerprint;
    let nextPasscodeVersion = Number(existing.passcode_version || 0);
    let passcodeChanged = false;

    if (data.passcode !== undefined && data.passcode !== null && String(data.passcode).trim() !== '') {
      const cleanCode = normalizePasscode(data.passcode);
      if (cleanCode.length < 4) {
        const err = new Error('Login code must be at least 4 characters');
        err.statusCode = 400;
        throw err;
      }
      if (Buffer.byteLength(cleanCode, 'utf8') > MAX_PASSCODE_BYTES) {
        const err = new Error(`Login code must be ${MAX_PASSCODE_BYTES} characters or fewer`);
        err.statusCode = 400;
        throw err;
      }
      if (profilesDB.isPasscodeInUse(cleanCode, id)) {
        throw createDuplicatePasscodeError();
      }
      nextPasscodeHash = bcrypt.hashSync(cleanCode, 10);
      nextPasscodeFingerprint = computePasscodeFingerprint(cleanCode);
      nextPasscodeVersion += 1;
      passcodeChanged = true;
    }

    const nextRole =
      existing.id === 'default'
        ? 'owner'
        : data.role === 'owner' || data.role === 'member'
          ? data.role
          : existing.role || 'member';

    const updated = {
      ...existing,
      name: data.name !== undefined ? String(data.name).trim() : existing.name,
      avatar: data.avatar !== undefined ? data.avatar : existing.avatar,
      color: data.color !== undefined ? data.color : existing.color,
      is_kids: data.is_kids !== undefined ? Boolean(data.is_kids) : existing.is_kids,
      role: nextRole,
      passcode_hash: nextPasscodeHash,
      ...(nextPasscodeFingerprint ? { passcode_fingerprint: nextPasscodeFingerprint } : {}),
      passcode_version: nextPasscodeVersion,
      updated_at: new Date(),
    };

    if (mongoose.connection.readyState === 1) {
      const { _id, __v, ...setFields } = updated;
      try {
        await ProfileModel.findOneAndUpdate({ id }, { $set: setFields });
      } catch (err) {
        if (err && err.code === 11000) {
          throw createDuplicatePasscodeError();
        }
        throw err;
      }
    }
    profileCache.set(id, updated);

    if (passcodeChanged && data.autoResolvePendingRequests !== false) {
      await resetRequestsDB.resolvePendingForProfile(id, 'Resolved via profile code update').catch(() => {});
    }

    return sanitizeProfile(updated);
  },

  delete: async (id) => {
    await ensureProfilesFresh(true);
    if (id === 'default') {
      const err = new Error('Cannot delete the primary Owner profile');
      err.statusCode = 400;
      throw err;
    }
    if (profileCache.size <= 1) {
      const err = new Error('Cannot delete the only remaining profile');
      err.statusCode = 400;
      throw err;
    }
    const target = profileCache.get(id);
    if (!target) {
      const err = new Error('Profile not found');
      err.statusCode = 404;
      throw err;
    }
    if ((target.role || 'member') === 'owner') {
      const otherOwners = Array.from(profileCache.values()).filter(
        (p) => p.id !== id && (p.role === 'owner' || p.id === 'default')
      );
      if (otherOwners.length === 0) {
        const err = new Error('Cannot delete the last Owner profile');
        err.statusCode = 400;
        throw err;
      }
    }

    profileCache.delete(id);
    watchlistCache.delete(id);
    const prefix = `${id}:`;
    for (const key of playbackCache.keys()) {
      if (key.startsWith(prefix)) playbackCache.delete(key);
    }
    if (mongoose.connection.readyState === 1) {
      await ProfileModel.deleteOne({ id });
      await PlaybackModel.deleteMany({ profile_id: id });
      await WatchlistModel.deleteMany({ profile_id: id });
    }
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
      if (mongoose.connection.readyState === 1) {
        await WatchlistModel.deleteOne({ profile_id: profileId, media_id: mediaId });
      }
      return { inWatchlist: false };
    } else {
      set.add(mediaId);
      if (mongoose.connection.readyState === 1) {
        await WatchlistModel.create({ profile_id: profileId, media_id: mediaId });
      }
      return { inWatchlist: true };
    }
  },

  isInWatchlist: (profileId = 'default', mediaId) => {
    const set = watchlistCache.get(profileId);
    return set ? set.has(mediaId) : false;
  },
};

function formatLockoutStatus(record, now = Date.now()) {
  if (!record) {
    return {
      locked: false,
      failedAttempts: 0,
      maxAttempts: MAX_LOGIN_ATTEMPTS,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS,
      lockedAt: null,
      expiresAt: null,
      resetRequestCount: 0,
    };
  }

  if (record.locked) {
    const expMs = record.expires_at ? new Date(record.expires_at).getTime() : 0;
    if (expMs > 0 && expMs <= now) {
      return {
        locked: false,
        expired: true,
        failedAttempts: 0,
        maxAttempts: MAX_LOGIN_ATTEMPTS,
        attemptsRemaining: MAX_LOGIN_ATTEMPTS,
        lockedAt: null,
        expiresAt: null,
        resetRequestCount: 0,
      };
    }
    return {
      locked: true,
      failedAttempts: Math.max(MAX_LOGIN_ATTEMPTS, Number(record.failed_attempts || MAX_LOGIN_ATTEMPTS)),
      maxAttempts: MAX_LOGIN_ATTEMPTS,
      attemptsRemaining: 0,
      lockedAt: record.locked_at ? new Date(record.locked_at).toISOString() : null,
      expiresAt: record.expires_at ? new Date(record.expires_at).toISOString() : null,
      resetRequestCount: Number(record.reset_request_count || 0),
    };
  }

  const lastMs = record.last_attempt_at ? new Date(record.last_attempt_at).getTime() : 0;
  const isStale = lastMs > 0 && now - lastMs > ATTEMPT_WINDOW_MS;
  const attempts = isStale ? 0 : Number(record.failed_attempts || 0);

  return {
    locked: false,
    failedAttempts: attempts,
    maxAttempts: MAX_LOGIN_ATTEMPTS,
    attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts),
    lockedAt: null,
    expiresAt: null,
    resetRequestCount: 0,
  };
}

// Persistent Multi-Instance Login Lockout DB Methods
export const lockoutsDB = {
  getStatus: async (clientIp, now = Date.now()) => {
    const clientKey = normalizeClientKey(clientIp);
    let record = lockoutCache.get(clientKey) || null;

    if (mongoose.connection.readyState === 1) {
      try {
        record = await AuthLockoutModel.findOne({ client_key: clientKey }).lean();
        if (record) {
          lockoutCache.set(clientKey, record);
        } else {
          lockoutCache.delete(clientKey);
        }
      } catch (err) {
        console.warn('[DB] Lockout read warning:', err.message);
      }
    }

    const status = formatLockoutStatus(record, now);
    if (status.expired) {
      await lockoutsDB.clear(clientKey);
      delete status.expired;
    }
    return status;
  },

  recordFailure: async (clientIp, now = Date.now()) => {
    const clientKey = normalizeClientKey(clientIp);
    const current = await lockoutsDB.getStatus(clientKey, now);
    if (current.locked) {
      return current;
    }

    const nextAttempts = current.failedAttempts + 1;
    const isNowLocked = nextAttempts >= MAX_LOGIN_ATTEMPTS;
    const nextDoc = {
      client_key: clientKey,
      failed_attempts: nextAttempts,
      locked: isNowLocked,
      locked_at: isNowLocked ? new Date(now) : null,
      expires_at: isNowLocked ? new Date(now + LOCKOUT_DURATION_MS) : null,
      last_attempt_at: new Date(now),
      reset_request_count: isNowLocked ? 0 : 0,
    };

    lockoutCache.set(clientKey, nextDoc);
    if (mongoose.connection.readyState === 1) {
      try {
        await AuthLockoutModel.findOneAndUpdate(
          { client_key: clientKey },
          { $set: nextDoc },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (err) {
        console.warn('[DB] Lockout write warning:', err.message);
      }
    }

    return formatLockoutStatus(nextDoc, now);
  },

  incrementResetRequestCount: async (clientIp) => {
    const clientKey = normalizeClientKey(clientIp);
    const existing = lockoutCache.get(clientKey);
    const nextCount = Number(existing?.reset_request_count || 0) + 1;
    if (existing) {
      lockoutCache.set(clientKey, { ...existing, reset_request_count: nextCount });
    }
    if (mongoose.connection.readyState === 1) {
      try {
        const updated = await AuthLockoutModel.findOneAndUpdate(
          { client_key: clientKey },
          { $inc: { reset_request_count: 1 } },
          { returnDocument: 'after' }
        ).lean();
        if (updated) {
          lockoutCache.set(clientKey, updated);
          return Number(updated.reset_request_count || nextCount);
        }
      } catch (err) {
        console.warn('[DB] Lockout reset_request_count warning:', err.message);
      }
    }
    return nextCount;
  },

  clear: async (clientIp) => {
    const clientKey = normalizeClientKey(clientIp);
    lockoutCache.delete(clientKey);
    if (mongoose.connection.readyState === 1) {
      await AuthLockoutModel.deleteOne({ client_key: clientKey }).catch((err) =>
        console.warn('[DB] Lockout clear warning:', err.message)
      );
    }
  },

  clearAll: async () => {
    lockoutCache.clear();
    if (mongoose.connection.readyState === 1) {
      await AuthLockoutModel.deleteMany({}).catch(() => {});
    }
  },
};

function enrichResetRequest(reqDoc) {
  if (!reqDoc) return null;
  const { _id, __v, ...clean } = reqDoc;
  const liveMatch = clean.matched_profile_id ? profilesDB.getById(clean.matched_profile_id) : null;
  return {
    ...clean,
    matched_profile: liveMatch,
  };
}

// Profile Reset Requests (In-App Owner Ping) DB Methods
export const resetRequestsDB = {
  create: async ({ requestedName, clientIp, failedAttempts = MAX_LOGIN_ATTEMPTS }) => {
    await ensureProfilesFresh(true);
    const cleanName = String(requestedName || '').trim().slice(0, 40);
    if (!cleanName) {
      const err = new Error('Profile name is required');
      err.statusCode = 400;
      throw err;
    }

    const clientKey = normalizeClientKey(clientIp);
    const matchedProfile = profilesDB.findByNameCaseInsensitive(cleanName);
    const now = new Date();

    // Deduplicate identical pending requests from the same locked IP
    const pendingList = await resetRequestsDB.getPending();
    const existingPending = pendingList.find(
      (r) =>
        r.client_ip === clientKey &&
        String(r.requested_name || '').trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (existingPending) {
      const updated = {
        ...existingPending,
        matched_profile_id: matchedProfile?.id || existingPending.matched_profile_id || null,
        matched_profile_name: matchedProfile?.name || existingPending.matched_profile_name || null,
        failed_attempts: failedAttempts,
        created_at: now,
      };
      delete updated.matched_profile;
      resetRequestCache.set(updated.id, updated);
      if (mongoose.connection.readyState === 1) {
        await ResetRequestModel.findOneAndUpdate({ id: updated.id }, { $set: updated }).catch((err) =>
          console.warn('[DB] ResetRequest update warning:', err.message)
        );
      }
      return enrichResetRequest(updated);
    }

    const doc = {
      id: `rst_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      requested_name: cleanName,
      matched_profile_id: matchedProfile?.id || null,
      matched_profile_name: matchedProfile?.name || null,
      client_ip: clientKey,
      failed_attempts: failedAttempts,
      status: 'pending',
      resolution_note: null,
      resolved_profile_id: null,
      created_at: now,
      resolved_at: null,
    };

    resetRequestCache.set(doc.id, doc);
    if (mongoose.connection.readyState === 1) {
      await ResetRequestModel.create(doc);
    }
    return enrichResetRequest(doc);
  },

  getPending: async () => {
    await ensureProfilesFresh(false);
    if (mongoose.connection.readyState === 1) {
      try {
        const docs = await ResetRequestModel.find({ status: 'pending' }).sort({ created_at: -1 }).limit(50).lean();
        docs.forEach((d) => resetRequestCache.set(d.id, d));
        return docs.map(enrichResetRequest);
      } catch (err) {
        console.warn('[DB] ResetRequest list warning:', err.message);
      }
    }
    return Array.from(resetRequestCache.values())
      .filter((r) => r.status === 'pending')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(enrichResetRequest);
  },

  getById: async (id) => {
    if (mongoose.connection.readyState === 1) {
      try {
        const doc = await ResetRequestModel.findOne({ id }).lean();
        if (doc) {
          resetRequestCache.set(doc.id, doc);
          return enrichResetRequest(doc);
        }
        return null;
      } catch (err) {
        console.warn('[DB] ResetRequest getById warning:', err.message);
      }
    }
    return enrichResetRequest(resetRequestCache.get(id) || null);
  },

  markResolved: async (id, { status = 'resolved', resolvedProfileId = null, resolutionNote = null } = {}) => {
    const existing = await resetRequestsDB.getById(id);
    if (!existing) return null;
    const { matched_profile, ...base } = existing;
    const updated = {
      ...base,
      status,
      resolved_profile_id: resolvedProfileId,
      resolution_note: resolutionNote,
      resolved_at: new Date(),
    };
    resetRequestCache.set(id, updated);
    if (mongoose.connection.readyState === 1) {
      await ResetRequestModel.findOneAndUpdate({ id }, { $set: updated }).catch((err) =>
        console.warn('[DB] ResetRequest resolve warning:', err.message)
      );
    }
    return enrichResetRequest(updated);
  },

  resolvePendingForProfile: async (profileId, resolutionNote = 'Resolved by Owner') => {
    if (!profileId) return 0;
    const pending = await resetRequestsDB.getPending();
    const matching = pending.filter((r) => r.matched_profile_id === profileId);
    for (const reqDoc of matching) {
      await lockoutsDB.clear(reqDoc.client_ip);
      await resetRequestsDB.markResolved(reqDoc.id, {
        status: 'resolved',
        resolvedProfileId: profileId,
        resolutionNote,
      });
    }
    return matching.length;
  },

  clearAll: async () => {
    resetRequestCache.clear();
    if (mongoose.connection.readyState === 1) {
      await ResetRequestModel.deleteMany({}).catch(() => {});
    }
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
    // Strip runtime stream, childProcess, abortController & torrent instances that cannot be serialized to MongoDB
    const { torrent, currentReadStream, currentWriteStream, childProcess, abortController, ...cleanData } = dl;
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

  upsertAsync: async (dl) => {
    const { torrent, currentReadStream, currentWriteStream, childProcess, abortController, ...cleanData } = dl;
    const docData = {
      ...cleanData,
      updated_at: new Date(),
    };

    downloadCache.set(dl.id, docData);

    if (mongoose.connection.readyState === 1) {
      await DownloadModel.findOneAndUpdate(
        { id: dl.id },
        { $set: docData },
        { upsert: true, returnDocument: 'after' }
      );
    }
    return docData;
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

export const iptvHealthDB = {
  loadAll: async () => {
    if (mongoose.connection.readyState !== 1) return [];
    try {
      return await IptvHealthModel.find({}).lean();
    } catch (err) {
      console.warn('[IPTV Health DB Load Warning]:', err.message);
      return [];
    }
  },

  upsertMany: async (records = []) => {
    if (mongoose.connection.readyState !== 1 || !records.length) return;
    try {
      await IptvHealthModel.bulkWrite(
        records.map((r) => ({
          updateOne: {
            filter: { channel_id: r.channel_id },
            update: { $set: { ...r, checked_at: new Date() } },
            upsert: true,
          },
        }))
      );
    } catch (err) {
      console.warn('[IPTV Health DB Upsert Warning]:', err.message);
    }
  },
};

export default {
  initDatabase,
  ensureMediaCacheFresh,
  ensureProfilesFresh,
  mediaDB,
  playbackDB,
  profilesDB,
  lockoutsDB,
  resetRequestsDB,
  downloadsDB,
  iptvHealthDB,
};
