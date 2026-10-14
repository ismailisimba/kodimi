import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, getFileMetadata, getSignedReadUrl } from '../config/gcs.js';
import { mediaDB } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const thumbsDir = path.resolve(__dirname, '../../data/thumbnails');

if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}

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
 * Samples at 42% and 69% of the video duration for dramatic, action-filled frames.
 */
export async function getOrGenerateThumbnail(mediaId, gcsPath, requestedVariant = 'random') {
  // Determine variant: '42', '69', or random
  let variant = requestedVariant;
  if (!variant || variant === 'random') {
    variant = Math.random() < 0.5 ? '42' : '69';
  }
  if (variant !== '42' && variant !== '69') {
    variant = '42';
  }

  const cacheFile = path.join(thumbsDir, `${mediaId}_${variant}.jpg`);
  const legacyFile = path.join(thumbsDir, `${mediaId}.jpg`);
  const svgFile = path.join(thumbsDir, `${mediaId}.svg`);

  if (fs.existsSync(cacheFile)) return cacheFile;

  try {
    const duration = await getOrProbeDuration(mediaId, gcsPath);
    let seekTime = 5;

    if (duration > 60) {
      seekTime = variant === '42' ? Math.round(duration * 0.42) : Math.round(duration * 0.69);
    } else if (duration > 10) {
      seekTime = variant === '42' ? Math.round(duration * 0.4) : Math.round(duration * 0.7);
    }

    const signedUrl = await getSignedReadUrl(gcsPath, 60);

    await new Promise((resolve, reject) => {
      ffmpeg(signedUrl)
        .inputOptions([
          '-probesize 1000000',
          '-analyzeduration 1000000',
          '-fflags +nobuffer+fastseek',
        ])
        .seekInput(seekTime)
        .outputOptions([
          '-map 0:v:0',
          '-vframes 1',
          '-vf scale=640:-1,format=yuv420p',
          '-f image2',
          '-c:v mjpeg',
          '-q:v 3',
        ])
        .save(cacheFile)
        .on('end', resolve)
        .on('error', () => {
          // Retry at 5s fallback
          ffmpeg(signedUrl)
            .inputOptions([
              '-probesize 1000000',
              '-analyzeduration 1000000',
            ])
            .seekInput(5)
            .outputOptions([
              '-map 0:v:0',
              '-vframes 1',
              '-vf scale=640:-1,format=yuv420p',
              '-f image2',
              '-c:v mjpeg',
            ])
            .save(cacheFile)
            .on('end', resolve)
            .on('error', reject);
        });
    });

    return cacheFile;
  } catch (err) {
    if (fs.existsSync(legacyFile)) return legacyFile;
    if (fs.existsSync(svgFile)) return svgFile;

    // Generate clean SVG cover
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e1e24"/>
          <stop offset="100%" stop-color="#0f0f11"/>
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#bg)"/>
      <circle cx="320" cy="180" r="44" fill="#e50914" opacity="0.9"/>
      <polygon points="312,162 336,180 312,198" fill="#ffffff"/>
      <text x="320" y="260" font-family="Roboto, sans-serif" font-size="16" fill="#808080" text-anchor="middle" font-weight="bold">KODIMI STREAM</text>
    </svg>`;
    fs.writeFileSync(svgFile, svgContent);
    return svgFile;
  }
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

export default {
  RESOLUTION_PROFILES,
  streamOriginalDirect,
  streamOriginalRemux,
  streamTranscodedVideo,
  streamSubtitles,
  getOrGenerateThumbnail,
  getSubtitleTracks,
  getOrProbeDuration,
};

