import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, getFileMetadata, getSignedReadUrl, getBucket } from '../config/gcs.js';
import { mediaDB } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const thumbsDir = path.resolve(__dirname, '../../data/thumbnails');

if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}

// In-flight thumbnail promise deduplication map
const inFlightThumbs = new Map();

export const RESOLUTION_PROFILES = {
  '144p': { width: 256, height: 144, videoBitrate: '140k', audioBitrate: '128k' },
  '240p': { width: 426, height: 240, videoBitrate: '280k', audioBitrate: '128k' },
  '360p': { width: 640, height: 360, videoBitrate: '500k', audioBitrate: '128k' },
  '480p': { width: 854, height: 480, videoBitrate: '900k', audioBitrate: '128k' },
  '720p': { width: 1280, height: 720, videoBitrate: '1800k', audioBitrate: '192k' },
  '1080p': { width: 1920, height: 1080, videoBitrate: '3500k', audioBitrate: '192k' },
};

/**
 * Handles direct Range-request streaming for original resolution (Raw Passthrough).
 */
export async function streamOriginalDirect(gcsPath, req, res) {
  const metadata = await getFileMetadata(gcsPath);
  const fileSize = metadata.size;
  const range = req.headers.range;

  const isMkv = gcsPath.toLowerCase().endsWith('.mkv');
  const contentType = isMkv ? 'video/x-matroska' : metadata.contentType || 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });

    const stream = createReadStream(gcsPath, { start, end });
    stream.on('error', (err) => {
      console.error(`[Stream Error - ${gcsPath}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
    });

    const stream = createReadStream(gcsPath);
    stream.on('error', (err) => {
      console.error(`[Stream Error - ${gcsPath}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  }
}

/**
 * Streams Original Video with universal AAC audio remuxing (-c:v copy -c:a aac).
 * Zero-loss original 1080p video with audio guaranteed to work in every browser.
 */
export async function streamOriginalRemux(gcsPath, startTimeSeconds = 0, req, res) {
  const signedUrl = await getSignedReadUrl(gcsPath, 120);

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
  });

  const command = ffmpeg(signedUrl)
    .inputOptions([
      '-probesize 1000000',
      '-analyzeduration 1000000',
      '-fflags +nobuffer',
    ]);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

  const remuxOutputOptions = [
    '-map 0:v:0',
    '-map 0:a:0?',
    '-c:v copy',
    '-c:a aac',
    '-b:a 192k',
    '-ar 48000',
    '-ac 2',
    '-threads 1',
    '-avoid_negative_ts make_zero',
    '-max_muxing_queue_size 1024',
    '-movflags frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets 1',
  ];

  command
    .format('mp4')
    .outputOptions(remuxOutputOptions);

  command.on('start', (cmdline) => {
    console.log(`[Remux Original Stream Started]: ${cmdline.substring(0, 100)}...`);
  });

  command.on('error', (err) => {
    if (err.message && (err.message.includes('SIGKILL') || err.message.includes('Output stream closed') || err.message.includes('pipe:1: End of file'))) {
      return;
    }
    console.warn(`[Remux Stream Error]: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });

  req.on('close', () => {
    try {
      command.kill('SIGKILL');
    } catch (_) {}
  });

  command.pipe(res, { end: true });
}

/**
 * Streams real-time FFMPEG downscaled video (144p, 240p, 360p, 480p, 720p).
 */
export async function streamTranscodedVideo(gcsPath, quality, startTimeSeconds = 0, req, res) {
  const profile = RESOLUTION_PROFILES[quality] || RESOLUTION_PROFILES['360p'];
  const signedUrl = await getSignedReadUrl(gcsPath, 120);

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
  });

  const command = ffmpeg(signedUrl)
    .inputOptions([
      '-probesize 1000000',
      '-analyzeduration 1000000',
      '-fflags +nobuffer',
    ]);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

  command
    .format('mp4')
    .outputOptions([
      '-map 0:v:0',
      '-map 0:a:0?',
      '-c:v libx264',
      `-vf scale=-2:${profile.height}`,
      `-b:v ${profile.videoBitrate}`,
      '-c:a aac',
      `-b:a ${profile.audioBitrate}`,
      '-ar 48000',
      '-ac 2',
      '-threads 1',
      '-preset ultrafast',
      '-tune zerolatency',
      '-g 48',
      '-keyint_min 24',
      '-sc_threshold 0',
      '-pix_fmt yuv420p',
      '-avoid_negative_ts make_zero',
      '-max_muxing_queue_size 1024',
      '-movflags frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets 1',
    ]);

  command.on('start', (cmdline) => {
    console.log(`[FFMPEG Transcode Started for ${quality}]: ${cmdline.substring(0, 100)}...`);
  });

  command.on('error', (err) => {
    if (err.message && (err.message.includes('SIGKILL') || err.message.includes('Output stream closed') || err.message.includes('pipe:1: End of file'))) {
      return;
    }
    console.warn(`[FFMPEG Stream Error]: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });

  req.on('close', () => {
    try {
      command.kill('SIGKILL');
    } catch (_) {}
  });

  command.pipe(res, { end: true });
}

/**
 * Extracts embedded subtitle stream as WebVTT for browser playback.
 */
export async function streamSubtitles(gcsPath, trackIndex = 0, req, res) {
  try {
    const signedUrl = await getSignedReadUrl(gcsPath, 60);

    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });

    const command = ffmpeg(signedUrl)
      .outputOptions([
        `-map 0:s:${trackIndex}?`, // Trailing ? makes subtitle mapping optional so it never hangs
        '-c:s webvtt',
        '-f webvtt',
      ]);

    const timeout = setTimeout(() => {
      try {
        command.kill('SIGKILL');
        if (!res.headersSent) res.status(200).send('WEBVTT\n\nNOTE No subtitles found');
      } catch (_) {}
    }, 6000);

    command.on('start', () => {
      // Subtitle extraction started
    });

    command.on('error', (err) => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.status(200).send('WEBVTT\n\nNOTE No subtitles available');
      }
    });

    command.on('end', () => {
      clearTimeout(timeout);
    });

    req.on('close', () => {
      clearTimeout(timeout);
      try {
        command.kill('SIGKILL');
      } catch (_) {}
    });

    command.pipe(res, { end: true });
  } catch (err) {
    console.error('[Subtitle Error]:', err.message);
    if (!res.headersSent) res.status(200).send('WEBVTT\n\nNOTE Subtitle extraction unavailable');
  }
}

const MIN_CINEMATIC_SIZE = 10000; // 10 KB - non-cinematic black screens & logo bumpers are ~4-7 KB

// In-memory inventory of valid GCS thumbnail keys (.thumbnails/...) and cached Signed URLs
let gcsThumbInventory = null;
let gcsInventoryPromise = null;
const signedThumbUrlCache = new Map();

async function ensureThumbInventory() {
  if (gcsThumbInventory) return gcsThumbInventory;
  if (gcsInventoryPromise) return gcsInventoryPromise;

  gcsInventoryPromise = (async () => {
    try {
      const bucket = getBucket();
      const [gcsFiles] = await bucket.getFiles({ prefix: '.thumbnails/' });
      const validSet = new Set();
      for (const f of gcsFiles) {
        if (parseInt(f.metadata?.size || 0, 10) >= MIN_CINEMATIC_SIZE) {
          validSet.add(f.name);
        }
      }
      gcsThumbInventory = validSet;
      return gcsThumbInventory;
    } catch (err) {
      console.warn('[Thumbnail Inventory Warning]:', err.message);
      return new Set();
    } finally {
      gcsInventoryPromise = null;
    }
  })();

  return gcsInventoryPromise;
}

/**
 * Resolves a direct GCS Signed Read URL for a cached thumbnail if available in GCS,
 * avoiding downloading or proxying image bytes through Cloud Run.
 */
export async function getThumbnailRedirectUrl(mediaId, gcsPath, requestedVariant = 'random') {
  let variant = requestedVariant;
  if (!variant || variant === 'random') {
    variant = Math.random() < 0.5 ? '42' : '69';
  }
  if (variant !== '42' && variant !== '69') {
    variant = '42';
  }

  const inventory = await ensureThumbInventory();
  const candidates = [
    `.thumbnails/${mediaId}_${variant}.jpg`,
    `.thumbnails/${mediaId}_${variant === '42' ? '69' : '42'}.jpg`,
    `.thumbnails/${mediaId}.jpg`,
  ];

  const matchedKey = candidates.find((k) => inventory.has(k));
  if (matchedKey) {
    const cached = signedThumbUrlCache.get(matchedKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.url;
    }
    try {
      // Sign for 24 hours, cache in memory for 12 hours
      const url = await getSignedReadUrl(matchedKey, 24 * 60);
      signedThumbUrlCache.set(matchedKey, {
        url,
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      return url;
    } catch (_) {}
  }

  return null;
}

/**
 * Generates and caches cinematic video frame screenshot thumbnails.
 * Backed by permanent GCS cloud storage (.thumbnails/) across all container deployments.
 */
export async function getOrGenerateThumbnail(mediaId, gcsPath, requestedVariant = 'random') {
  let variant = requestedVariant;
  if (!variant || variant === 'random') {
    variant = Math.random() < 0.5 ? '42' : '69';
  }
  if (variant !== '42' && variant !== '69') {
    variant = '42';
  }

  const cacheFile = path.join(thumbsDir, `${mediaId}_${variant}.jpg`);
  const legacyFile = path.join(thumbsDir, `${mediaId}.jpg`);
  const altFile = path.join(thumbsDir, `${mediaId}_${variant === '42' ? '69' : '42'}.jpg`);

  // 1. Check local ephemeral disk for any valid variant of this item
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size >= MIN_CINEMATIC_SIZE) return cacheFile;
  if (fs.existsSync(altFile) && fs.statSync(altFile).size >= MIN_CINEMATIC_SIZE) return altFile;
  if (fs.existsSync(legacyFile) && fs.statSync(legacyFile).size >= MIN_CINEMATIC_SIZE) return legacyFile;

  // 2. In-flight promise deduplication to prevent multiple concurrent extractions
  const dedupKey = `${mediaId}_${variant}`;
  if (inFlightThumbs.has(dedupKey)) {
    return inFlightThumbs.get(dedupKey);
  }

  const thumbPromise = (async () => {
    try {
      const bucket = getBucket();
      const inventory = await ensureThumbInventory();

      // 3. Check persistent GCS cache (.thumbnails/) for any valid variant before running FFmpeg
      const gcsKey = `.thumbnails/${mediaId}_${variant}.jpg`;
      const altGcsKey = `.thumbnails/${mediaId}_${variant === '42' ? '69' : '42'}.jpg`;
      const legacyGcsKey = `.thumbnails/${mediaId}.jpg`;

      const downloadIfCinematic = async (key, dest) => {
        try {
          if (inventory.size > 0 && !inventory.has(key)) return null;
          const file = bucket.file(key);
          const [exists] = await file.exists().catch(() => [false]);
          if (!exists) return null;
          const [meta] = await file.getMetadata().catch(() => [{}]);
          const sz = parseInt(meta?.size || 0, 10);
          if (sz >= MIN_CINEMATIC_SIZE) {
            await file.download({ destination: dest });
            if (fs.existsSync(dest) && fs.statSync(dest).size >= MIN_CINEMATIC_SIZE) {
              inventory.add(key);
              return dest;
            }
          }
        } catch (_) {}
        return null;
      };

      const primaryCached = await downloadIfCinematic(gcsKey, cacheFile);
      if (primaryCached) return primaryCached;

      const altCached = await downloadIfCinematic(altGcsKey, altFile);
      if (altCached) return altCached;

      const legacyCached = await downloadIfCinematic(legacyGcsKey, legacyFile);
      if (legacyCached) return legacyCached;

      // 4. Generate with FFmpeg ONLY if no valid thumbnail exists in GCS for this mediaId
      if (!gcsPath) return null;

      const item = mediaDB.getById(mediaId);
      let duration = (item && item.duration > 0) ? item.duration : 0;
      if (!duration || duration <= 0) {
        try {
          duration = await getOrProbeDuration(mediaId, gcsPath);
        } catch (_) {}
      }

      // True cinematic candidate timestamps (deep into actual narrative/action, avoiding intros & bumpers)
      let candidates = [];
      if (duration > 60) {
        if (variant === '42') {
          candidates = [
            Math.round(duration * 0.42),
            Math.round(duration * 0.46),
            Math.round(duration * 0.38),
          ];
        } else {
          candidates = [
            Math.round(duration * 0.68),
            Math.round(duration * 0.72),
            Math.round(duration * 0.64),
          ];
        }
      } else if (duration > 10) {
        candidates = variant === '42'
          ? [Math.round(duration * 0.42), Math.round(duration * 0.50)]
          : [Math.round(duration * 0.68), Math.round(duration * 0.75)];
      } else {
        // Unknown duration: seek deep into full-length media (10-25 mins)
        candidates = variant === '42' ? [600, 780, 960] : [1200, 1500, 1800];
      }

      const signedUrl = await getSignedReadUrl(gcsPath, 120);

      const extractFrame = (targetSeek) => {
        return new Promise((resolve, reject) => {
          let command = null;
          const timeout = setTimeout(() => {
            try { if (command) command.kill('SIGKILL'); } catch (_) {}
            reject(new Error('Thumbnail extraction timed out'));
          }, 15000);

          command = ffmpeg(signedUrl)
            .inputOptions([
              '-probesize 1000000',
              '-analyzeduration 1000000',
              '-fflags +nobuffer+fastseek',
            ])
            .seekInput(targetSeek)
            .outputOptions([
              '-map 0:v:0',
              '-vframes 1',
              '-vf scale=640:-1,format=yuv420p',
              '-f image2',
              '-c:v mjpeg',
              '-q:v 2',
            ])
            .save(cacheFile)
            .on('end', () => {
              clearTimeout(timeout);
              if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 500) {
                resolve(fs.statSync(cacheFile).size);
              } else {
                reject(new Error('Empty frame output'));
              }
            })
            .on('error', (err) => {
              clearTimeout(timeout);
              try { if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile); } catch (_) {}
              reject(err);
            });
        });
      };

      let bestSize = 0;
      let generated = false;

      for (const seekSec of candidates) {
        try {
          const sz = await extractFrame(seekSec);
          if (sz >= MIN_CINEMATIC_SIZE) {
            bestSize = sz;
            generated = true;
            break; // Found high-detail cinematic frame!
          } else if (sz > bestSize) {
            bestSize = sz;
            generated = true;
          }
        } catch (_) {}
      }

      if (generated && fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 500) {
        // Upload to GCS and register in inventory so future requests get a direct 302 GCS redirect
        bucket.upload(cacheFile, {
          destination: gcsKey,
          metadata: {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000',
          },
        }).then(() => {
          if (gcsThumbInventory) gcsThumbInventory.add(gcsKey);
        }).catch((err) => console.warn(`[GCS Thumb Upload Error for ${mediaId}]:`, err.message));

        return cacheFile;
      }

      return null;
    } catch (err) {
      try { if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size < 500) fs.unlinkSync(cacheFile); } catch (_) {}
      console.warn(`[Thumbnail Generation Warning for ${mediaId}]:`, err.message);
      return null;
    } finally {
      inFlightThumbs.delete(dedupKey);
    }
  })();

  inFlightThumbs.set(dedupKey, thumbPromise);
  return thumbPromise;
}

const subtitleTracksCache = new Map();

const LANGUAGE_MAP = {
  eng: 'English',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  por: 'Portuguese',
  rus: 'Russian',
  chi: 'Chinese',
  zho: 'Chinese',
  jpn: 'Japanese',
  kor: 'Korean',
  ara: 'Arabic',
  hin: 'Hindi',
  tur: 'Turkish',
  pol: 'Polish',
  dut: 'Dutch',
  nld: 'Dutch',
  swe: 'Swedish',
  dan: 'Danish',
  fin: 'Finnish',
  nor: 'Norwegian',
  nob: 'Norwegian',
  cze: 'Czech',
  ces: 'Czech',
  gre: 'Greek',
  ell: 'Greek',
  heb: 'Hebrew',
  hun: 'Hungarian',
  ind: 'Indonesian',
  rum: 'Romanian',
  ron: 'Romanian',
  tha: 'Thai',
  vie: 'Vietnamese',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  slv: 'Slovenian',
  slo: 'Slovak',
  slk: 'Slovak',
  est: 'Estonian',
  lav: 'Latvian',
  lit: 'Lithuanian',
};

/**
 * Probes media file with ffprobe to retrieve all available embedded subtitle streams.
 */
export async function getSubtitleTracks(mediaId, gcsPath) {
  if (subtitleTracksCache.has(mediaId)) {
    return subtitleTracksCache.get(mediaId);
  }

  try {
    const signedUrl = await getSignedReadUrl(gcsPath, 60);
    const tracks = await new Promise((resolve) => {
      ffmpeg.ffprobe(signedUrl, (err, metadata) => {
        if (err || !metadata || !metadata.streams) {
          return resolve([]);
        }

        const subStreams = [];
        let subIndex = 0;

        for (const s of metadata.streams) {
          if (s.codec_type === 'subtitle') {
            const langCode = (s.tags?.language || 'und').toLowerCase();
            const langName = LANGUAGE_MAP[langCode] || (langCode !== 'und' ? langCode.toUpperCase() : 'Unknown');
            const customTitle = s.tags?.title;
            let label = customTitle
              ? (customTitle.toLowerCase().includes(langName.toLowerCase()) ? customTitle : `${langName} (${customTitle})`)
              : langName;

            subStreams.push({
              trackIndex: subIndex,
              language: langCode,
              label: label || `Track ${subIndex + 1}`,
              codec: s.codec_name,
            });
            subIndex++;
          }
        }
        resolve(subStreams);
      });
    });

    subtitleTracksCache.set(mediaId, tracks);
    return tracks;
  } catch (err) {
    console.warn(`[Subtitle Tracks Probe Error]: ${err.message}`);
    return [];
  }
}

/**
 * Probes and caches media duration in seconds.
 * Automatically persists to database if missing.
 */
export async function getOrProbeDuration(mediaId, gcsPath) {
  const existing = mediaDB.getById(mediaId);
  if (existing && existing.duration > 0) {
    return existing.duration;
  }

  try {
    const signedUrl = await getSignedReadUrl(gcsPath, 60);
    const duration = await new Promise((resolve) => {
      ffmpeg(signedUrl)
        .inputOptions([
          '-probesize 1000000',
          '-analyzeduration 1000000',
        ])
        .ffprobe((err, data) => {
          if (err || !data || !data.format || !data.format.duration) {
            return resolve(0);
          }
          const dur = Math.round(parseFloat(data.format.duration));
          resolve(dur > 0 ? dur : 0);
        });
    });

    if (duration > 0 && existing) {
      mediaDB.upsert({
        ...existing,
        duration,
      });
      console.log(`[Duration Cached]: ${existing.title} -> ${duration}s (${Math.floor(duration / 60)}m ${duration % 60}s)`);
    }

    return duration;
  } catch (err) {
    console.warn(`[Duration Probe Error]: ${err.message}`);
    return 0;
  }
}

/**
 * Background warmer: ensures all media items in MongoDB have pre-rendered thumbnails in GCS.
 * Runs with low concurrency (1 at a time) so streaming CPU is never impacted.
 */
export async function startThumbnailWarmer() {
  setTimeout(async () => {
    try {
      const bucket = getBucket();
      const items = mediaDB.getAll({ limit: 1000 });
      console.log(`[Thumbnail Warmer] Checking ${items.length} media items in catalog...`);

      const [gcsFiles] = await bucket.getFiles({ prefix: '.thumbnails/' });
      const validGcsThumbSet = new Set(
        gcsFiles
          .filter((f) => parseInt(f.metadata?.size || 0, 10) >= MIN_CINEMATIC_SIZE)
          .map((f) => f.name.replace('.thumbnails/', ''))
      );
      console.log(`[Thumbnail Warmer] Found ${validGcsThumbSet.size} pre-rendered cinematic thumbnails in GCS.`);

      let warmed = 0;
      for (const item of items) {
        if (!item.gcs_path) continue;
        const key42 = `${item.id}_42.jpg`;
        const key69 = `${item.id}_69.jpg`;
        const hasThumb = validGcsThumbSet.has(key42) || validGcsThumbSet.has(key69);

        if (!hasThumb) {
          try {
            await getOrGenerateThumbnail(item.id, item.gcs_path, '42');
            warmed++;
            // Gentle pacing: 250ms delay between items
            await new Promise((r) => setTimeout(r, 250));
          } catch (_) {}
        }
      }
      if (warmed > 0) {
        console.log(`[Thumbnail Warmer] Successfully warmed and uploaded ${warmed} missing thumbnails to GCS.`);
      } else {
        console.log('[Thumbnail Warmer] All media items already have persistent thumbnails in GCS.');
      }
    } catch (err) {
      console.warn('[Thumbnail Warmer Error]:', err.message);
    }
  }, 5000); // Wait 5s after startup
}

export default {
  RESOLUTION_PROFILES,
  streamOriginalDirect,
  streamOriginalRemux,
  streamTranscodedVideo,
  streamSubtitles,
  getThumbnailRedirectUrl,
  getOrGenerateThumbnail,
  getSubtitleTracks,
  getOrProbeDuration,
  startThumbnailWarmer,
};

