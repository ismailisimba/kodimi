import ffmpeg from 'fluent-ffmpeg';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, getFileMetadata, getSignedReadUrl, getBucket } from '../config/gcs.js';
import { mediaDB } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const thumbsDir = path.resolve(__dirname, '../../data/thumbnails');
const subsDir = path.resolve(__dirname, '../../data/subtitles');

if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}
if (!fs.existsSync(subsDir)) {
  fs.mkdirSync(subsDir, { recursive: true });
}

// In-flight deduplication & caching maps
const inFlightThumbs = new Map();
const inFlightSubtitles = new Map();
const signedReadUrlCache = new Map();

// Active FFmpeg process registry keyed by playback session ID (prevents zombie FFmpeg processes & Cloud Run 429s)
const activeSessionStreams = new Map();

// Cached FFmpeg encoder availability
let detectedEncoders = null;

/**
 * Probes local FFmpeg binary once for available modern video encoders (SVT-AV1, x265, x264).
 */
export function detectAvailableEncoders() {
  if (detectedEncoders) return detectedEncoders;
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    detectedEncoders = {
      av1: /\blibsvtav1\b/.test(out),
      hevc: /\blibx265\b/.test(out),
      h264: /\blibx264\b/.test(out),
    };
  } catch (_) {
    detectedEncoders = { av1: false, hevc: false, h264: true };
  }
  console.log(`[Transcoder] Available video encoders: AV1=${detectedEncoders.av1}, HEVC=${detectedEncoders.hevc}, H264=${detectedEncoders.h264}`);
  return detectedEncoders;
}

/**
 * Resolves the best available server encoder matching the client's requested codec capability.
 */
export function resolveTargetCodec(requestedCodec = 'h264', encoders = detectAvailableEncoders()) {
  const norm = (requestedCodec || 'h264').toLowerCase().trim();
  if (norm === 'av1') {
    if (encoders.av1) return 'av1';
    if (encoders.hevc) return 'hevc';
    return 'h264';
  }
  if (norm === 'hevc' || norm === 'x265' || norm === 'h265') {
    if (encoders.hevc) return 'hevc';
    return 'h264';
  }
  return 'h264';
}

export const RESOLUTION_PROFILES = {
  '144p': {
    width: 256,
    height: 144,
    videoBitrate: '125k',
    av1MaxrateKbps: 85,
    av1Crf: 42,
    hevcMaxrateKbps: 95,
    hevcCrf: 34,
    h264MaxrateKbps: 125,
    h264Crf: 30,
    minFloorKbps: 55,
    sourceScaleRatio: 0.16,
    audioBitrate: '48k',
    audioKbps: 48,
  },
  '240p': {
    width: 426,
    height: 240,
    videoBitrate: '210k',
    av1MaxrateKbps: 140,
    av1Crf: 40,
    hevcMaxrateKbps: 155,
    hevcCrf: 32,
    h264MaxrateKbps: 210,
    h264Crf: 29,
    minFloorKbps: 90,
    sourceScaleRatio: 0.25,
    audioBitrate: '48k',
    audioKbps: 48,
  },
  '360p': {
    width: 640,
    height: 360,
    videoBitrate: '340k',
    av1MaxrateKbps: 230,
    av1Crf: 38,
    hevcMaxrateKbps: 250,
    hevcCrf: 31,
    h264MaxrateKbps: 340,
    h264Crf: 28,
    minFloorKbps: 140,
    sourceScaleRatio: 0.36,
    audioBitrate: '64k',
    audioKbps: 64,
  },
  '480p': {
    width: 854,
    height: 480,
    videoBitrate: '550k',
    av1MaxrateKbps: 380,
    av1Crf: 36,
    hevcMaxrateKbps: 420,
    hevcCrf: 30,
    h264MaxrateKbps: 550,
    h264Crf: 27,
    minFloorKbps: 220,
    sourceScaleRatio: 0.50,
    audioBitrate: '64k',
    audioKbps: 64,
  },
  '720p': {
    width: 1280,
    height: 720,
    videoBitrate: '950k',
    av1MaxrateKbps: 680,
    av1Crf: 34,
    hevcMaxrateKbps: 740,
    hevcCrf: 29,
    h264MaxrateKbps: 950,
    h264Crf: 26,
    minFloorKbps: 340,
    sourceScaleRatio: 0.68,
    audioBitrate: '96k',
    audioKbps: 96,
  },
  '1080p-low': {
    width: 1920,
    height: 1080,
    videoBitrate: '1250k',
    av1MaxrateKbps: 1150,
    av1Crf: 32,
    hevcMaxrateKbps: 1250,
    hevcCrf: 28,
    h264MaxrateKbps: 1650,
    h264Crf: 25,
    minFloorKbps: 550,
    sourceScaleRatio: 0.85,
    smartRemuxThresholdKbps: 1450,
    audioBitrate: '96k',
    audioKbps: 96,
  },
  '1080p': {
    width: 1920,
    height: 1080,
    videoBitrate: '1250k',
    av1MaxrateKbps: 1150,
    av1Crf: 32,
    hevcMaxrateKbps: 1250,
    hevcCrf: 28,
    h264MaxrateKbps: 1650,
    h264Crf: 25,
    minFloorKbps: 550,
    sourceScaleRatio: 0.85,
    smartRemuxThresholdKbps: 1450,
    audioBitrate: '96k',
    audioKbps: 96,
  },
};

/**
 * Computes source bitrate (in kbps) from size_bytes & duration, and produces an
 * optimized transcode plan that never inflates bitrate above the original source.
 */
export function computeEffectiveTranscodePlan(item, quality, requestedCodec = 'h264', options = {}) {
  const profile = RESOLUTION_PROFILES[quality] || RESOLUTION_PROFILES['360p'];
  const codec = resolveTargetCodec(requestedCodec, options.encoders);

  let sourceTotalKbps = item?.bitrate_kbps > 0 ? item.bitrate_kbps : 0;
  if (!sourceTotalKbps && item?.size_bytes > 0 && item?.duration > 0) {
    sourceTotalKbps = Math.round((item.size_bytes * 8) / (item.duration * 1000));
  }

  let baseMaxrateKbps = profile.h264MaxrateKbps;
  let crf = profile.h264Crf;
  if (codec === 'av1') {
    baseMaxrateKbps = profile.av1MaxrateKbps;
    crf = profile.av1Crf;
  } else if (codec === 'hevc') {
    baseMaxrateKbps = profile.hevcMaxrateKbps;
    crf = profile.hevcCrf;
  }

  // Determine whether source video codec is compatible with direct fMP4 stream-copy on this client
  const srcCodecRaw = `${item?.video_codec || ''} ${item?.filename || ''} ${item?.gcs_path || ''}`.toLowerCase();
  const isSourceHevc = /\b(hevc|x265|h265|h\.265)\b/.test(srcCodecRaw);
  const isSourceAv1 = /\b(av1|av01)\b/.test(srcCodecRaw);
  const clientSupportsHevc = Boolean(options.clientSupportsHevc || codec === 'hevc');
  const clientSupportsAv1 = Boolean(options.clientSupportsAv1 || codec === 'av1');

  const canClientDecodeSourceCopy = isSourceHevc
    ? clientSupportsHevc
    : isSourceAv1
      ? clientSupportsAv1
      : true; // H.264 / AVC is universally supported

  // Smart Remux for 1080p-low: if original file is already low-bandwidth (e.g. ~180MB 1080p episode <= 1450 kbps),
  // avoid wasting CPU or losing quality by copying the already-optimized video stream directly!
  const is1080Low = quality === '1080p-low' || quality === '1080p';
  const shouldSmartRemux = Boolean(
    is1080Low &&
    profile.smartRemuxThresholdKbps &&
    sourceTotalKbps > 0 &&
    sourceTotalKbps <= profile.smartRemuxThresholdKbps &&
    canClientDecodeSourceCopy
  );

  // Proportional downscale bitrate ceiling: ensures 720p/480p/360p ALWAYS consume less bandwidth than Original
  let effectiveMaxrateKbps = baseMaxrateKbps;
  if (sourceTotalKbps > 0) {
    const estimatedSourceVideoKbps = Math.max(120, sourceTotalKbps - 128);
    const proportionalCapKbps = Math.round(estimatedSourceVideoKbps * profile.sourceScaleRatio);
    const clampedCap = Math.max(profile.minFloorKbps, proportionalCapKbps);
    // Never exceed profile maxrate, and if source is ultra-compact, cap below source video bitrate
    effectiveMaxrateKbps = Math.min(baseMaxrateKbps, clampedCap);
    if (effectiveMaxrateKbps >= estimatedSourceVideoKbps && estimatedSourceVideoKbps > profile.minFloorKbps) {
      effectiveMaxrateKbps = Math.max(profile.minFloorKbps, Math.round(estimatedSourceVideoKbps * 0.8));
    }
  }

  return {
    codec,
    profile,
    crf,
    sourceTotalKbps,
    baseMaxrateKbps,
    effectiveMaxrateKbps,
    bufsizeKbps: effectiveMaxrateKbps * 2,
    audioBitrate: profile.audioBitrate,
    shouldSmartRemux,
    isSourceHevc,
  };
}

/**
 * Returns a cached GCS V4 Signed Read URL so repeated seeks resolve in 0ms.
 */
async function getCachedSignedReadUrl(gcsPath, expiresInMinutes = 120) {
  const cached = signedReadUrlCache.get(gcsPath);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.url;
  }
  const url = await getSignedReadUrl(gcsPath, expiresInMinutes);
  const ttlMs = Math.max(1, expiresInMinutes - 15) * 60 * 1000;
  signedReadUrlCache.set(gcsPath, {
    url,
    expiresAt: Date.now() + ttlMs,
  });
  return url;
}

/**
 * Registers an FFmpeg command for a playback session, immediately terminating any prior
 * FFmpeg process on the same session and binding cleanup to res.on('close') (Node 22 safe).
 */
export function registerActiveStream(sessionKey, command, res) {
  if (sessionKey && activeSessionStreams.has(sessionKey)) {
    const prev = activeSessionStreams.get(sessionKey);
    activeSessionStreams.delete(sessionKey);
    try {
      prev.kill('SIGKILL');
    } catch (_) {}
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (sessionKey && activeSessionStreams.get(sessionKey) === command) {
      activeSessionStreams.delete(sessionKey);
    }
    try {
      command.kill('SIGKILL');
    } catch (_) {}
  };

  if (sessionKey) {
    activeSessionStreams.set(sessionKey, command);
  }

  res.on('close', cleanup);
  res.on('error', cleanup);
  command.on('end', () => {
    if (sessionKey && activeSessionStreams.get(sessionKey) === command) {
      activeSessionStreams.delete(sessionKey);
    }
  });

  return cleanup;
}

export function getActiveStreamCount() {
  return activeSessionStreams.size;
}

/**
 * Builds the exact FFmpeg input and output option arrays for Original Remux (-c:v copy -c:a aac),
 * preserving B-frame PTS/DTS alignment and keyframe-locked A/V lip-sync across seeks.
 */
export function buildOriginalRemuxOptions(startTimeSeconds = 0, options = {}) {
  const audioBitrate = options.audioBitrate || '160k';
  const isSourceHevc = Boolean(options.isSourceHevc);

  const inputOptions = [
    '-probesize', '5000000',
    '-analyzeduration', '5000000',
    '-fflags', '+genpts',
  ];

  if (startTimeSeconds > 0) {
    // Lock audio seek to the exact same video keyframe so -c:v copy and -c:a aac start at identical timestamps
    inputOptions.push('-noaccurate_seek');
  }

  const audioFilter = startTimeSeconds > 0
    ? 'aresample=async=1'
    : 'aresample=async=1:first_pts=0';

  const outputOptions = [
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
  ];

  if (isSourceHevc) {
    outputOptions.push('-tag:v', 'hvc1');
  }

  outputOptions.push(
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-ar', '48000',
    '-ac', '2',
    '-af', audioFilter,
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '2048',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1'
  );

  return { inputOptions, outputOptions };
}

/**
 * Handles direct Range-request streaming for original resolution (Raw Passthrough).
 */
export async function streamOriginalDirect(gcsPath, req, res) {
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const metadata = await getFileMetadata(gcsPath);
  if (clientClosed || res.destroyed || res.writableEnded) return;

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
    res.on('close', () => {
      try { stream.destroy(); } catch (_) {}
    });
    stream.on('error', (err) => {
      if (!clientClosed) console.error(`[Stream Error - ${gcsPath}]:`, err.message);
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
    res.on('close', () => {
      try { stream.destroy(); } catch (_) {}
    });
    stream.on('error', (err) => {
      if (!clientClosed) console.error(`[Stream Error - ${gcsPath}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  }
}

/**
 * Streams Original Video with universal AAC audio remuxing (-c:v copy -c:a aac)
 * and frame-locked A/V timestamp synchronization.
 */
export async function streamOriginalRemux(gcsPath, startTimeSeconds = 0, req, res, options = {}) {
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const item = options.item || mediaDB.getByGcsPath(gcsPath);
  const sessionKey = options.sessionId || (req.query?.sid ? String(req.query.sid) : null);

  const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);
  if (clientClosed || res.destroyed || res.writableEnded) return;

  const srcRaw = `${item?.video_codec || ''} ${item?.filename || ''} ${gcsPath}`.toLowerCase();
  const isSourceHevc = /\b(hevc|x265|h265|h\.265)\b/.test(srcRaw);

  const { inputOptions, outputOptions } = buildOriginalRemuxOptions(startTimeSeconds, {
    audioBitrate: options.audioBitrate || '160k',
    isSourceHevc,
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
  });

  const command = ffmpeg(signedUrl).inputOptions(inputOptions);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

  command.format('mp4').outputOptions(outputOptions);

  const cleanup = registerActiveStream(sessionKey, command, res);

  command.on('start', (cmdline) => {
    console.log(`[Remux Original Stream Started (t=${Math.round(startTimeSeconds)}s)]: ${cmdline.substring(0, 110)}...`);
  });

  command.on('error', (err) => {
    cleanup();
    if (
      clientClosed ||
      (err.message &&
        (err.message.includes('SIGKILL') ||
          err.message.includes('Output stream closed') ||
          err.message.includes('pipe:1: End of file') ||
          err.message.includes('Broken pipe')))
    ) {
      return;
    }
    console.warn(`[Remux Stream Error]: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).end();
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  command.pipe(res, { end: true });
}

/**
 * Streams real-time FFMPEG low-bandwidth video using AV1 (libsvtav1), HEVC (libx265), or tuned H.264,
 * with capped-CRF rate control and smart passthrough when the original file is already optimized.
 */
export async function streamTranscodedVideo(gcsPath, quality, startTimeSeconds = 0, req, res, options = {}) {
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  let item = options.item || mediaDB.getByGcsPath(gcsPath);
  const sessionKey = options.sessionId || (req.query?.sid ? String(req.query.sid) : null);
  const requestedCodec = options.codec || req.query?.codec || 'h264';
  const clientSupportsHevc = options.clientSupportsHevc ?? (req.query?.hevc === '1' || requestedCodec === 'hevc');
  const clientSupportsAv1 = options.clientSupportsAv1 ?? (req.query?.av1 === '1' || requestedCodec === 'av1');

  // Ensure duration is known if size_bytes exists so smart bitrate ceiling works accurately
  if (item && item.size_bytes > 0 && (!item.duration || item.duration <= 0)) {
    try {
      const dur = await getOrProbeDuration(item.id, gcsPath);
      if (dur > 0) {
        item = mediaDB.getById(item.id) || { ...item, duration: dur };
      }
    } catch (_) {}
  }

  if (clientClosed || res.destroyed || res.writableEnded) return;

  const plan = computeEffectiveTranscodePlan(item, quality, requestedCodec, {
    clientSupportsHevc,
    clientSupportsAv1,
  });

  // Smart Remux shortcut for 1080p-low when original 1080p file is already low-bandwidth
  if (plan.shouldSmartRemux) {
    console.log(`[Smart 1080p-Low] Source is already optimized (${plan.sourceTotalKbps} kbps <= 1450 kbps). Using zero-loss Smart Remux.`);
    return streamOriginalRemux(gcsPath, startTimeSeconds, req, res, {
      item,
      sessionId: sessionKey,
      audioBitrate: plan.audioBitrate,
    });
  }

  const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);
  if (clientClosed || res.destroyed || res.writableEnded) return;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
  });

  const command = ffmpeg(signedUrl).inputOptions([
    '-probesize', '3000000',
    '-analyzeduration', '3000000',
    '-fflags', '+genpts',
  ]);

  if (startTimeSeconds > 0) {
    command.seekInput(startTimeSeconds);
  }

  const videoCodecArgs = [];
  if (plan.codec === 'av1') {
    const preset = plan.profile.height >= 1080 ? '11' : '10';
    videoCodecArgs.push(
      '-c:v', 'libsvtav1',
      '-preset', preset,
      '-crf', String(plan.crf),
      '-maxrate', `${plan.effectiveMaxrateKbps}k`,
      '-bufsize', `${plan.bufsizeKbps}k`,
      '-g', '120',
      '-pix_fmt', 'yuv420p'
    );
  } else if (plan.codec === 'hevc') {
    const preset = plan.profile.height >= 1080 ? 'ultrafast' : 'superfast';
    videoCodecArgs.push(
      '-c:v', 'libx265',
      '-preset', preset,
      '-crf', String(plan.crf),
      '-maxrate', `${plan.effectiveMaxrateKbps}k`,
      '-bufsize', `${plan.bufsizeKbps}k`,
      '-g', '120',
      '-pix_fmt', 'yuv420p',
      '-tag:v', 'hvc1'
    );
  } else {
    videoCodecArgs.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(plan.crf),
      '-maxrate', `${plan.effectiveMaxrateKbps}k`,
      '-bufsize', `${plan.bufsizeKbps}k`,
      '-g', '120',
      '-pix_fmt', 'yuv420p'
    );
  }

  command
    .format('mp4')
    .outputOptions([
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', `scale=-2:min(${plan.profile.height}\\,trunc(ih/2)*2)`,
      ...videoCodecArgs,
      '-c:a', 'aac',
      '-b:a', plan.audioBitrate,
      '-ar', '48000',
      '-ac', '2',
      '-af', 'aresample=async=1',
      '-threads', '0',
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '2048',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
    ]);

  const cleanup = registerActiveStream(sessionKey, command, res);

  command.on('start', (cmdline) => {
    console.log(
      `[FFMPEG Transcode Started: ${quality} | codec=${plan.codec} | maxrate=${plan.effectiveMaxrateKbps}k (src=${plan.sourceTotalKbps || '?'}k)]: ${cmdline.substring(0, 100)}...`
    );
  });

  command.on('error', (err) => {
    cleanup();
    if (
      clientClosed ||
      (err.message &&
        (err.message.includes('SIGKILL') ||
          err.message.includes('Output stream closed') ||
          err.message.includes('pipe:1: End of file') ||
          err.message.includes('Broken pipe')))
    ) {
      return;
    }
    console.warn(`[FFMPEG Stream Error]: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).end();
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  command.pipe(res, { end: true });
}

/**
 * Normalizes and converts .vtt, .srt, or .ass/.ssa subtitle text into clean UTF-8 WebVTT.
 */
export function convertSubtitleToWebVTT(rawText, filename = '') {
  if (!rawText || typeof rawText !== 'string') {
    return 'WEBVTT\n\n';
  }

  let text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lowerName = (filename || '').toLowerCase();

  const cleanAssOverrides = (str) =>
    str
      .replace(/\{\\i1\}/gi, '<i>')
      .replace(/\{\\i0\}/gi, '</i>')
      .replace(/\{\\b1\}/gi, '<b>')
      .replace(/\{\\b0\}/gi, '</b>')
      .replace(/\{\\u1\}/gi, '<u>')
      .replace(/\{\\u0\}/gi, '</u>')
      .replace(/\{[^}]*\}/g, '');

  // 1. SubStation Alpha (.ass / .ssa)
  if (lowerName.endsWith('.ass') || lowerName.endsWith('.ssa') || /^\[Script Info\]/im.test(text) || /^\[Events\]/im.test(text)) {
    const lines = text.split('\n');
    let inEvents = false;
    let formatCols = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const cues = [];

    const formatAssTime = (t) => {
      const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
      if (!m) return null;
      const hh = m[1].padStart(2, '0');
      const mm = m[2];
      const ss = m[3];
      const frac = m[4].length === 2 ? `${m[4]}0` : m[4].padEnd(3, '0').slice(0, 3);
      return `${hh}:${mm}:${ss}.${frac}`;
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (/^\[Events\]/i.test(trimmed)) {
        inEvents = true;
        continue;
      }
      if (inEvents && /^\[.+\]$/.test(trimmed)) {
        inEvents = false;
        continue;
      }
      if (!inEvents) continue;

      if (/^Format\s*:/i.test(trimmed)) {
        const spec = trimmed.replace(/^Format\s*:/i, '').split(',').map((c) => c.trim().toLowerCase());
        if (spec.length >= 3) formatCols = spec;
        continue;
      }

      if (/^Dialogue\s*:/i.test(trimmed)) {
        const payload = trimmed.replace(/^Dialogue\s*:\s*/i, '');
        const parts = [];
        let cursor = 0;
        for (let c = 0; c < formatCols.length - 1; c++) {
          const commaIdx = payload.indexOf(',', cursor);
          if (commaIdx === -1) break;
          parts.push(payload.slice(cursor, commaIdx));
          cursor = commaIdx + 1;
        }
        parts.push(payload.slice(cursor));

        const startIdx = formatCols.indexOf('start');
        const endIdx = formatCols.indexOf('end');
        const textIdx = formatCols.indexOf('text');
        if (startIdx === -1 || endIdx === -1 || textIdx === -1 || parts.length <= textIdx) continue;

        // Skip ASS vector drawing commands ({\p1}...)
        if (/\{\\p[1-9]\}/i.test(parts[textIdx])) continue;

        const startVtt = formatAssTime(parts[startIdx]);
        const endVtt = formatAssTime(parts[endIdx]);
        if (!startVtt || !endVtt) continue;

        const cueText = cleanAssOverrides(parts[textIdx])
          .replace(/\\N/g, '\n')
          .replace(/\\n/g, '\n')
          .replace(/\\h/g, ' ')
          .trim();

        if (cueText) {
          cues.push({ startVtt, endVtt, cueText });
        }
      }
    }

    cues.sort((a, b) => a.startVtt.localeCompare(b.startVtt));
    const body = cues.map((c) => `${c.startVtt} --> ${c.endVtt}\n${c.cueText}`).join('\n\n');
    return `WEBVTT\n\n${body}\n`;
  }

  // 2. Already WebVTT (.vtt)
  if (/^WEBVTT\b/i.test(text.trim())) {
    const cleaned = cleanAssOverrides(text.trim());
    return `${cleaned}\n`;
  }

  // 3. SubRip (.srt) -> WebVTT
  const blocks = text.trim().split(/\n{2,}/);
  const vttBlocks = [];

  const normalizeSrtTimestamp = (h, m, s, ms) => {
    const hh = (h || '00').padStart(2, '0');
    const mm = m.padStart(2, '0');
    const ss = s.padStart(2, '0');
    const mmm = ms.padEnd(3, '0').slice(0, 3);
    return `${hh}:${mm}:${ss}.${mmm}`;
  };

  const tsRegex = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})(.*)$/;

  for (const block of blocks) {
    const bLines = block.split('\n').map((l) => l.trimEnd());
    let tsLineIdx = -1;
    let match = null;
    for (let i = 0; i < Math.min(3, bLines.length); i++) {
      const m = bLines[i].trim().match(tsRegex);
      if (m) {
        tsLineIdx = i;
        match = m;
        break;
      }
    }
    if (tsLineIdx === -1 || !match) continue;

    const start = normalizeSrtTimestamp(match[1], match[2], match[3], match[4]);
    const end = normalizeSrtTimestamp(match[5], match[6], match[7], match[8]);
    const settings = (match[9] || '').trim();
    const header = settings ? `${start} --> ${end} ${settings}` : `${start} --> ${end}`;
    const cueBody = cleanAssOverrides(bLines.slice(tsLineIdx + 1).join('\n')).trim();

    if (cueBody) {
      vttBlocks.push(`${header}\n${cueBody}`);
    }
  }

  return `WEBVTT\n\n${vttBlocks.join('\n\n')}\n`;
}

/**
 * Extracts complete embedded subtitle track to WebVTT and caches permanently in GCS (.subtitles/).
 * Never caches partial/aborted extractions.
 */
export async function getOrExtractSubtitles(mediaId, gcsPath, trackIndex = 0) {
  const safeMediaId = mediaId || Buffer.from(gcsPath).toString('hex').slice(0, 24);
  const localFile = path.join(subsDir, `${safeMediaId}_track_${trackIndex}.vtt`);
  const gcsSubKey = `.subtitles/${safeMediaId}_track_${trackIndex}.vtt`;

  // 1. Check ephemeral local cache
  if (fs.existsSync(localFile) && fs.statSync(localFile).size > 20) {
    const cachedText = fs.readFileSync(localFile, 'utf8');
    if (cachedText.includes('-->')) {
      return cachedText;
    }
  }

  // 2. Deduplicate concurrent extractions for the same track
  const dedupKey = `${safeMediaId}_track_${trackIndex}`;
  if (inFlightSubtitles.has(dedupKey)) {
    return inFlightSubtitles.get(dedupKey);
  }

  const extractPromise = (async () => {
    const tempFile = path.join(subsDir, `${safeMediaId}_track_${trackIndex}_${Date.now()}.tmp.vtt`);
    try {
      const bucket = getBucket();

      // 3. Check persistent GCS cache (.subtitles/)
      try {
        const gcsFile = bucket.file(gcsSubKey);
        const [exists] = await gcsFile.exists();
        if (exists) {
          const [contents] = await gcsFile.download();
          const vttStr = contents.toString('utf8');
          if (vttStr.includes('-->')) {
            fs.writeFileSync(localFile, vttStr, 'utf8');
            return vttStr;
          }
        }
      } catch (_) {}

      // 4. Full extraction from media container using -vn -an (demuxes subtitle packets only at full speed)
      const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);

      await new Promise((resolve, reject) => {
        let cmd = null;
        const timeout = setTimeout(() => {
          try { if (cmd) cmd.kill('SIGKILL'); } catch (_) {}
          reject(new Error('Subtitle extraction timed out after 180s'));
        }, 180000);

        cmd = ffmpeg(signedUrl)
          .inputOptions([
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
          ])
          .outputOptions([
            '-vn',
            '-an',
            '-map', `0:s:${trackIndex}?`,
            '-c:s', 'webvtt',
            '-f', 'webvtt',
          ])
          .save(tempFile)
          .on('end', () => {
            clearTimeout(timeout);
            resolve();
          })
          .on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
      });

      if (!fs.existsSync(tempFile)) {
        return null;
      }

      const rawExtracted = fs.readFileSync(tempFile, 'utf8');
      try { fs.unlinkSync(tempFile); } catch (_) {}

      const normalizedVtt = convertSubtitleToWebVTT(rawExtracted, 'extracted.vtt');
      if (!normalizedVtt.includes('-->')) {
        return null;
      }

      fs.writeFileSync(localFile, normalizedVtt, 'utf8');

      // Persist asynchronously to GCS so future loads across containers take <50ms
      bucket
        .file(gcsSubKey)
        .save(Buffer.from(normalizedVtt, 'utf8'), {
          contentType: 'text/vtt; charset=utf-8',
          resumable: false,
          metadata: {
            cacheControl: 'public, max-age=31536000',
          },
        })
        .catch((err) => console.warn(`[GCS Subtitle Cache Upload Warning]: ${err.message}`));

      return normalizedVtt;
    } catch (err) {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      console.warn(`[Subtitle Extraction Warning (${safeMediaId} track ${trackIndex})]: ${err.message}`);
      return null;
    } finally {
      inFlightSubtitles.delete(dedupKey);
    }
  })();

  inFlightSubtitles.set(dedupKey, extractPromise);
  return extractPromise;
}

/**
 * Fetches a persisted custom WebVTT subtitle file from local cache or GCS.
 */
export async function getCustomSubtitleContent(mediaId, customSub) {
  if (!customSub || !customSub.gcs_path) return null;
  const localFile = path.join(subsDir, `${mediaId}_${customSub.id}.vtt`);

  if (fs.existsSync(localFile) && fs.statSync(localFile).size > 10) {
    return fs.readFileSync(localFile, 'utf8');
  }

  try {
    const bucket = getBucket();
    const [contents] = await bucket.file(customSub.gcs_path).download();
    const text = contents.toString('utf8');
    fs.writeFileSync(localFile, text, 'utf8');
    return text;
  } catch (err) {
    console.warn(`[Custom Subtitle Fetch Error (${customSub.gcs_path})]:`, err.message);
    return null;
  }
}

/**
 * Converts, validates, and permanently stores a user-uploaded subtitle (.srt, .vtt, .ass) in GCS + MongoDB.
 */
export async function saveCustomSubtitle(item, { filename = 'subtitle.srt', label = '', language = 'und', content = '' }) {
  const normalizedVtt = convertSubtitleToWebVTT(content, filename);
  if (!normalizedVtt.includes('-->')) {
    throw new Error('No valid subtitle timestamp cues found in uploaded file');
  }

  const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const gcsSubKey = `.subtitles/${item.id}_${subId}.vtt`;
  const localFile = path.join(subsDir, `${item.id}_${subId}.vtt`);

  const cleanLabel = (label || filename.replace(/\.(srt|vtt|ass|ssa)$/i, '') || 'Custom Subtitle').trim().slice(0, 60);

  // Save locally & to persistent GCS
  fs.writeFileSync(localFile, normalizedVtt, 'utf8');
  const bucket = getBucket();
  await bucket.file(gcsSubKey).save(Buffer.from(normalizedVtt, 'utf8'), {
    contentType: 'text/vtt; charset=utf-8',
    resumable: false,
    metadata: {
      cacheControl: 'public, max-age=31536000',
    },
  });

  const subRecord = {
    id: subId,
    label: cleanLabel.includes('(Custom)') ? cleanLabel : `${cleanLabel} (Custom)`,
    language: (language || 'und').toLowerCase().slice(0, 10),
    gcs_path: gcsSubKey,
    format: 'vtt',
    created_at: new Date(),
  };

  const existingCustom = Array.isArray(item.custom_subtitles) ? item.custom_subtitles : [];
  await mediaDB.upsert({
    ...item,
    custom_subtitles: [...existingCustom, subRecord],
  });

  return { track: subRecord, vtt: normalizedVtt };
}

/**
 * Deletes a custom uploaded subtitle from MongoDB, local cache, and GCS.
 */
export async function deleteCustomSubtitle(item, subId) {
  const existingCustom = Array.isArray(item.custom_subtitles) ? item.custom_subtitles : [];
  const target = existingCustom.find((s) => s.id === subId);
  if (!target) {
    return false;
  }

  const remaining = existingCustom.filter((s) => s.id !== subId);
  await mediaDB.upsert({
    ...item,
    custom_subtitles: remaining,
  });

  const localFile = path.join(subsDir, `${item.id}_${subId}.vtt`);
  try { if (fs.existsSync(localFile)) fs.unlinkSync(localFile); } catch (_) {}

  if (target.gcs_path) {
    try {
      const bucket = getBucket();
      await bucket.file(target.gcs_path).delete({ ignoreNotFound: true });
    } catch (_) {}
  }

  return true;
}

/**
 * Serves complete WebVTT subtitles (embedded track or persisted custom upload).
 */
export async function streamSubtitles(gcsPath, trackIndex = 0, req, res, options = {}) {
  try {
    const mediaId = options.mediaId || req.params?.id;
    const customSub = options.customSub || null;

    let vttContent = null;
    if (customSub) {
      vttContent = await getCustomSubtitleContent(mediaId, customSub);
    } else {
      vttContent = await getOrExtractSubtitles(mediaId, gcsPath, trackIndex);
    }

    if (res.destroyed || res.writableEnded) return;

    if (vttContent && vttContent.includes('-->')) {
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(vttContent);
    } else {
      // Never cache empty/failed subtitle extractions!
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end('WEBVTT\n\nNOTE No text subtitles available for this track\n');
    }
  } catch (err) {
    console.error('[Subtitle Error]:', err.message);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).send('WEBVTT\n\nNOTE Subtitle extraction unavailable\n');
    }
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

      const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);

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
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

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
 * Probes media file with ffprobe to retrieve all available embedded text subtitle streams,
 * merged with any permanently uploaded custom subtitles in GCS/MongoDB.
 */
export async function getSubtitleTracks(mediaId, gcsPath) {
  let embeddedTracks = subtitleTracksCache.get(mediaId);

  if (!embeddedTracks) {
    try {
      const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);
      embeddedTracks = await new Promise((resolve) => {
        ffmpeg.ffprobe(signedUrl, (err, metadata) => {
          if (err || !metadata || !metadata.streams) {
            return resolve([]);
          }

          const subStreams = [];
          let subIndex = 0;

          for (const s of metadata.streams) {
            if (s.codec_type === 'subtitle') {
              const isBitmap = BITMAP_SUBTITLE_CODECS.has(s.codec_name);
              const langCode = (s.tags?.language || 'und').toLowerCase();
              const langName = LANGUAGE_MAP[langCode] || (langCode !== 'und' ? langCode.toUpperCase() : 'Unknown');
              const customTitle = s.tags?.title;
              let label = customTitle
                ? (customTitle.toLowerCase().includes(langName.toLowerCase()) ? customTitle : `${langName} (${customTitle})`)
                : langName;

              if (!isBitmap) {
                subStreams.push({
                  id: `embedded_${subIndex}`,
                  trackIndex: subIndex,
                  language: langCode,
                  label: label || `Track ${subIndex + 1}`,
                  codec: s.codec_name,
                  isCustom: false,
                });
              }
              subIndex++;
            }
          }
          resolve(subStreams);
        });
      });

      subtitleTracksCache.set(mediaId, embeddedTracks);
    } catch (err) {
      console.warn(`[Subtitle Tracks Probe Error]: ${err.message}`);
      embeddedTracks = [];
    }
  }

  const item = mediaDB.getById(mediaId);
  const customList = Array.isArray(item?.custom_subtitles)
    ? item.custom_subtitles.map((c) => ({
        id: c.id,
        customId: c.id,
        trackIndex: null,
        language: c.language || 'und',
        label: c.label || 'Custom Subtitle',
        codec: 'webvtt',
        isCustom: true,
      }))
    : [];

  return [...customList, ...embeddedTracks];
}

/**
 * Probes and caches media duration (seconds) and bitrate (kbps).
 * Automatically persists to database if missing.
 */
export async function getOrProbeDuration(mediaId, gcsPath) {
  const existing = mediaDB.getById(mediaId);
  if (existing && existing.duration > 0) {
    return existing.duration;
  }

  try {
    const signedUrl = await getCachedSignedReadUrl(gcsPath, 120);
    const probeResult = await new Promise((resolve) => {
      ffmpeg(signedUrl)
        .inputOptions([
          '-probesize 2000000',
          '-analyzeduration 2000000',
        ])
        .ffprobe((err, data) => {
          if (err || !data || !data.format || !data.format.duration) {
            return resolve({ duration: 0, bitrateKbps: 0, videoCodec: '' });
          }
          const dur = Math.round(parseFloat(data.format.duration));
          const br = data.format.bit_rate ? Math.round(parseInt(data.format.bit_rate, 10) / 1000) : 0;
          const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
          resolve({
            duration: dur > 0 ? dur : 0,
            bitrateKbps: br > 0 ? br : 0,
            videoCodec: vStream?.codec_name || '',
          });
        });
    });

    if (probeResult.duration > 0 && existing) {
      const computedKbps = probeResult.bitrateKbps ||
        (existing.size_bytes > 0 ? Math.round((existing.size_bytes * 8) / (probeResult.duration * 1000)) : 0);

      await mediaDB.upsert({
        ...existing,
        duration: probeResult.duration,
        bitrate_kbps: computedKbps,
        video_codec: existing.video_codec || probeResult.videoCodec || undefined,
      });
      console.log(
        `[Duration Cached]: ${existing.title} -> ${probeResult.duration}s (${Math.floor(probeResult.duration / 60)}m ${probeResult.duration % 60}s, ~${computedKbps} kbps)`
      );
    }

    return probeResult.duration;
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

// Detect encoders at module initialization
detectAvailableEncoders();

export default {
  RESOLUTION_PROFILES,
  detectAvailableEncoders,
  resolveTargetCodec,
  computeEffectiveTranscodePlan,
  buildOriginalRemuxOptions,
  registerActiveStream,
  getActiveStreamCount,
  convertSubtitleToWebVTT,
  getOrExtractSubtitles,
  saveCustomSubtitle,
  deleteCustomSubtitle,
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
