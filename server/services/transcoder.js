import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, getFileMetadata, getSignedReadUrl } from '../config/gcs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const thumbsDir = path.resolve(__dirname, '../../data/thumbnails');

if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}

export const RESOLUTION_PROFILES = {
  '144p': { width: 256, height: 144, videoBitrate: '140k', audioBitrate: '32k' },
  '240p': { width: 426, height: 240, videoBitrate: '280k', audioBitrate: '48k' },
  '360p': { width: 640, height: 360, videoBitrate: '500k', audioBitrate: '64k' },
  '480p': { width: 854, height: 480, videoBitrate: '900k', audioBitrate: '96k' },
  '720p': { width: 1280, height: 720, videoBitrate: '1800k', audioBitrate: '128k' },
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
    .format('mp4')
    .outputOptions([
      '-map 0:v:0',    // Video stream 0 only
      '-map 0:a:0?',   // Primary audio stream only
      '-c:v copy',     // Bit-for-bit video copy (0 CPU encoding loss)
      '-c:a aac',      // Universal AAC stereo audio
      '-b:a 192k',
      '-preset ultrafast',
      '-movflags frag_keyframe+empty_moov+default_base_moof',
    ]);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

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
    .format('mp4')
    .videoCodec('libx264')
    .size(`?x${profile.height}`)
    .videoBitrate(profile.videoBitrate)
    .audioCodec('aac')
    .audioBitrate(profile.audioBitrate)
    .outputOptions([
      '-preset ultrafast',
      '-tune zerolatency',
      '-movflags frag_keyframe+empty_moov+default_base_moof',
      '-pix_fmt yuv420p',
    ]);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

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
 * Generates and caches a video frame screenshot thumbnail.
 * Highly resilient with fallback to SVG if video cannot be sampled.
 */
export async function getOrGenerateThumbnail(mediaId, gcsPath) {
  const cacheFile = path.join(thumbsDir, `${mediaId}.jpg`);
  const svgFile = path.join(thumbsDir, `${mediaId}.svg`);

  if (fs.existsSync(cacheFile)) return cacheFile;
  if (fs.existsSync(svgFile)) return svgFile;

  try {
    const signedUrl = await getSignedReadUrl(gcsPath, 30);

    await new Promise((resolve, reject) => {
      ffmpeg(signedUrl)
        .seekInput(5) // sample at 5s
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
          // Retry at 1s for short clips
          ffmpeg(signedUrl)
            .seekInput(1)
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

export default {
  RESOLUTION_PROFILES,
  streamOriginalDirect,
  streamOriginalRemux,
  streamTranscodedVideo,
  streamSubtitles,
  getOrGenerateThumbnail,
  getSubtitleTracks,
};
