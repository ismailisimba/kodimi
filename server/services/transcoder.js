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

  const isSeeking = startTimeSeconds > 0;
  const remuxOutputOptions = [
    '-map 0:v:0',
    '-map 0:a:0?',
  ];

  if (isSeeking) {
    remuxOutputOptions.push(
      '-c:v libx264',
      '-preset ultrafast',
      '-tune zerolatency',
      '-crf 18',
      '-pix_fmt yuv420p',
      '-g 48',
      '-keyint_min 24',
      '-sc_threshold 0'
    );
  } else {
    remuxOutputOptions.push('-c:v copy');
  }

  remuxOutputOptions.push(
    '-c:a aac',
    '-b:a 192k',
    '-ar 48000',
    '-ac 2',
    '-threads 0',
    '-avoid_negative_ts make_zero',
    '-max_muxing_queue_size 1024',
    '-movflags frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets 1'
  );

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
      '-threads 0',
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

  // 1. Check local ephemeral disk
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 500) return cacheFile;
  if (fs.existsSync(legacyFile) && fs.statSync(legacyFile).size > 500) return legacyFile;
  if (fs.existsSync(altFile) && fs.statSync(altFile).size > 500) return altFile;

  // 2. In-flight promise deduplication to prevent multiple concurrent extractions
  const dedupKey = `${mediaId}_${variant}`;
  if (inFlightThumbs.has(dedupKey)) {
    return inFlightThumbs.get(dedupKey);
  }

  const thumbPromise = (async () => {
    try {
      const bucket = getBucket();

      // 3. Check persistent GCS cache (.thumbnails/)
      const gcsKey = `.thumbnails/${mediaId}_${variant}.jpg`;
      const legacyGcsKey = `.thumbnails/${mediaId}.jpg`;
      const altGcsKey = `.thumbnails/${mediaId}_${variant === '42' ? '69' : '42'}.jpg`;

      const [existsPrimary] = await bucket.file(gcsKey).exists().catch(() => [false]);
      if (existsPrimary) {
        await bucket.file(gcsKey).download({ destination: cacheFile });
        return cacheFile;
      }

      const [existsLegacy] = await bucket.file(legacyGcsKey).exists().catch(() => [false]);
      if (existsLegacy) {
        await bucket.file(legacyGcsKey).download({ destination: legacyFile });
        return legacyFile;
      }

      const [existsAlt] = await bucket.file(altGcsKey).exists().catch(() => [false]);
      if (existsAlt) {
        await bucket.file(altGcsKey).download({ destination: altFile });
        return altFile;
      }

      // 4. Generate with FFmpeg if not yet cached in GCS
      if (!gcsPath) return null;

      const item = mediaDB.getById(mediaId);
      const duration = (item && item.duration > 0) ? item.duration : 0;
      let seekTime = 2;

      if (duration > 120) {
        // Fast seek into early 15% - 35% of video
        seekTime = variant === '42'
          ? Math.min(180, Math.max(30, Math.round(duration * 0.15)))
          : Math.min(420, Math.max(60, Math.round(duration * 0.35)));
      } else if (duration > 10) {
        seekTime = Math.max(2, Math.round(duration * 0.3));
      } else {
        seekTime = variant === '42' ? 2 : 5;
      }

      const signedUrl = await getSignedReadUrl(gcsPath, 60);

      const extractFrame = (targetSeek) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Thumbnail extraction timed out'));
          }, 12000);

          ffmpeg(signedUrl)
            .seekInput(targetSeek)
            .inputOptions([
              '-noaccurate_seek',
              '-probesize 131072',
              '-analyzeduration 131072',
              '-fflags +nobuffer+fastseek',
            ])
            .outputOptions([
              '-map 0:v:0',
              '-vframes 1',
              '-vf scale=640:-1,format=yuv420p',
              '-f image2',
              '-c:v mjpeg',
              '-q:v 3',
            ])
            .save(cacheFile)
            .on('end', () => {
              clearTimeout(timeout);
              if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 500) {
                resolve();
              } else {
                reject(new Error('Empty frame output'));
              }
            })
            .on('error', (err) => {
              clearTimeout(timeout);
              try { if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size < 500) fs.unlinkSync(cacheFile); } catch (_) {}
              reject(err);
            });
        });
      };

      try {
        await extractFrame(seekTime);
      } catch (firstErr) {
        if (seekTime > 2) {
          await extractFrame(1.5);
        } else {
          throw firstErr;
        }
      }

      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 500) {
        // Asynchronously upload to GCS so all future instances/restarts get instant thumbnails
        bucket.upload(cacheFile, {
          destination: gcsKey,
          metadata: {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000',
          },
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
      const existingGcsThumbSet = new Set(gcsFiles.map((f) => f.name.replace('.thumbnails/', '')));
      console.log(`[Thumbnail Warmer] Found ${existingGcsThumbSet.size} pre-rendered thumbnails in GCS.`);

      let warmed = 0;
      for (const item of items) {
        if (!item.gcs_path) continue;
        const key42 = `${item.id}_42.jpg`;
        const key69 = `${item.id}_69.jpg`;
        const hasThumb = existingGcsThumbSet.has(key42) || existingGcsThumbSet.has(key69) || existingGcsThumbSet.has(`${item.id}.jpg`);

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
  getOrGenerateThumbnail,
  getSubtitleTracks,
  getOrProbeDuration,
  startThumbnailWarmer,
};

