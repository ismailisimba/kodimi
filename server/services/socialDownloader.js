import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import config from '../config/env.js';
import { createWriteStream } from '../config/gcs.js';
import { heuristicParseFilename } from './aiTagger.js';

const TMPFS_SAFE_BYTES = 1.35 * 1024 * 1024 * 1024; // ~1.35 GiB max before preferring zero-tmpfs streaming to GCS

const SOCIAL_PLATFORMS = [
  {
    id: 'youtube',
    label: 'YouTube',
    hosts: ['youtube.com', 'youtu.be', 'music.youtube.com'],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    hosts: ['instagram.com', 'instagr.am'],
  },
  {
    id: 'twitter',
    label: 'Twitter',
    hosts: ['twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    hosts: ['reddit.com', 'v.redd.it', 'redd.it'],
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    hosts: ['linkedin.com', 'lnkd.in'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    hosts: ['facebook.com', 'fb.watch', 'fb.com'],
  },
];

let cachedRunner = null;

/**
 * Detects whether a URL belongs to a supported social media platform.
 * Returns { id, label } or null.
 */
export function detectSocialPlatform(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  for (const platform of SOCIAL_PLATFORMS) {
    for (const allowed of platform.hosts) {
      if (host === allowed || host.endsWith(`.${allowed}`)) {
        return { id: platform.id, label: platform.label };
      }
    }
  }
  return null;
}

/**
 * Inspects a social media URL for playlist / multi-video collection patterns.
 * Returns { isExplicitPlaylist, hasPlaylistParam, isAutoMix, supportsPlaylist, listId }.
 */
export function detectPlaylistIntent(rawUrl) {
  const empty = {
    isExplicitPlaylist: false,
    hasPlaylistParam: false,
    isAutoMix: false,
    supportsPlaylist: false,
    listId: null,
  };
  const platform = detectSocialPlatform(rawUrl);
  if (!platform) return empty;

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return empty;
  }

  const pathname = parsed.pathname.toLowerCase();
  const listParam = parsed.searchParams.get('list');

  if (platform.id === 'youtube') {
    const isAutoMix = Boolean(listParam && /^RD/i.test(listParam));
    const isPlaylistPath =
      pathname === '/playlist' ||
      pathname.startsWith('/playlist/') ||
      pathname.startsWith('/course') ||
      pathname.startsWith('/podcasts') ||
      /\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|shorts|streams|playlists)\/?$/i.test(pathname);
    const hasPlaylistParam = Boolean(listParam);
    const isExplicitPlaylist = Boolean(
      isPlaylistPath || (hasPlaylistParam && !pathname.startsWith('/watch') && !isAutoMix)
    );
    return {
      isExplicitPlaylist,
      hasPlaylistParam,
      isAutoMix,
      supportsPlaylist: true,
      listId: listParam || null,
    };
  }

  if (platform.id === 'facebook') {
    const isExplicitPlaylist =
      pathname.includes('/watch/playlist') ||
      pathname.includes('/playlists') ||
      pathname.includes('/media/set');
    return {
      isExplicitPlaylist,
      hasPlaylistParam: isExplicitPlaylist,
      isAutoMix: false,
      supportsPlaylist: true,
      listId: null,
    };
  }

  if (platform.id === 'instagram') {
    const isExplicitPlaylist =
      pathname.includes('/stories/highlights/') || pathname.includes('/collections/');
    return {
      isExplicitPlaylist,
      hasPlaylistParam: isExplicitPlaylist,
      isAutoMix: false,
      supportsPlaylist: true,
      listId: null,
    };
  }

  if (platform.id === 'reddit') {
    const isExplicitPlaylist = pathname.includes('/collection/');
    return {
      isExplicitPlaylist,
      hasPlaylistParam: isExplicitPlaylist,
      isAutoMix: false,
      supportsPlaylist: true,
      listId: null,
    };
  }

  // Twitter/X multi-video posts and LinkedIn multi-video posts can also yield multiple entries via yt-dlp
  return {
    isExplicitPlaylist: false,
    hasPlaylistParam: false,
    isAutoMix: false,
    supportsPlaylist: true,
    listId: null,
  };
}

/**
 * Resolves the available yt-dlp executable (standalone binary or python -m yt_dlp).
 */
export function resolveYtDlpRunner() {
  if (cachedRunner) return cachedRunner;

  const candidates = [];
  if (config.ytDlpPath) {
    candidates.push({ cmd: config.ytDlpPath, prefixArgs: [] });
  }
  candidates.push({ cmd: 'yt-dlp', prefixArgs: [] });
  candidates.push({ cmd: 'python3', prefixArgs: ['-m', 'yt_dlp'] });
  candidates.push({ cmd: 'python', prefixArgs: ['-m', 'yt_dlp'] });

  for (const cand of candidates) {
    try {
      const probe = spawnSync(cand.cmd, [...cand.prefixArgs, '--version'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (probe.status === 0 && (probe.stdout || '').trim()) {
        cachedRunner = { ...cand, version: probe.stdout.trim() };
        console.log(`[SocialDownloader] Resolved yt-dlp runner: ${cand.cmd} ${cand.prefixArgs.join(' ')} (v${cachedRunner.version})`);
        return cachedRunner;
      }
    } catch (_) {}
  }

  return null;
}

export function sanitizeFilenameSegment(name, fallback = 'video') {
  const cleaned = String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function writeTempCookiesIfConfigured(workDir) {
  const b64 = process.env.YT_DLP_COOKIES_B64 || config.ytDlpCookiesB64;
  if (!b64 || !String(b64).trim()) return null;
  try {
    const decoded = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
    if (!decoded.trim()) return null;
    const cookiePath = path.join(workDir, 'cookies.txt');
    fs.writeFileSync(cookiePath, decoded, { mode: 0o600 });
    return cookiePath;
  } catch (err) {
    console.warn('[SocialDownloader] Failed to decode YT_DLP_COOKIES_B64:', err.message);
    return null;
  }
}

function buildBaseArgs(cookiePath, { allowPlaylist = false, playlistEnd = null } = {}) {
  const args = [
    allowPlaylist ? '--yes-playlist' : '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
  ];
  if (allowPlaylist) {
    args.push('--ignore-errors');
    if (playlistEnd && Number(playlistEnd) > 0) {
      args.push('--playlist-end', String(Math.min(100, Math.max(1, Number(playlistEnd)))));
    }
  }
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }
  return args;
}

function runYtDlpJsonProbe(runner, url, cookiePath, { flatPlaylist = false, maxItems = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...runner.prefixArgs,
      ...buildBaseArgs(cookiePath, {
        allowPlaylist: flatPlaylist,
        playlistEnd: flatPlaylist ? maxItems : null,
      }),
      ...(flatPlaylist ? ['--flat-playlist'] : []),
      '--dump-single-json',
      '--skip-download',
      url,
    ];

    const child = spawn(runner.cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Metadata extraction timed out after 60s'));
    }, 60000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        const cleanErr = stderr.trim().split('\n').slice(-2).join(' ') || `yt-dlp exited with code ${code}`;
        return reject(new Error(cleanErr));
      }
      try {
        const json = JSON.parse(stdout.trim());
        resolve(json);
      } catch (parseErr) {
        reject(new Error(`Failed to parse social media metadata: ${parseErr.message}`));
      }
    });
  });
}

function parseProgressLine(line) {
  // Expected format from --progress-template: "KODIMI_PROG|42.5%|1234567|9876543|450000"
  if (!line.startsWith('KODIMI_PROG|')) return null;
  const parts = line.split('|');
  if (parts.length < 5) return null;
  const pct = parseFloat(String(parts[1] || '0').replace('%', ''));
  const downloaded = parseInt(parts[2], 10);
  const total = parseInt(parts[3], 10);
  const speed = parseFloat(parts[4]);
  return {
    progress: Number.isFinite(pct) ? Math.min(99, Math.max(0, pct)) : null,
    downloaded_bytes: Number.isFinite(downloaded) ? downloaded : null,
    total_bytes: Number.isFinite(total) ? total : null,
    speed: Number.isFinite(speed) ? Math.round(speed) : null,
  };
}

function parseUploadYear(uploadDate) {
  if (!uploadDate || typeof uploadDate !== 'string') return new Date().getFullYear();
  const y = parseInt(uploadDate.slice(0, 4), 10);
  return Number.isFinite(y) && y >= 1990 && y <= 2035 ? y : new Date().getFullYear();
}

function isUnavailableEntry(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const title = String(entry.title || '').trim().toLowerCase();
  if (title === '[private video]' || title === '[deleted video]' || title === '[unavailable video]') {
    return true;
  }
  return false;
}

/**
 * Normalizes flat-playlist entries from yt-dlp across YouTube & social platforms.
 */
export function normalizePlaylistEntries(probeJson, sourceUrl, platform, maxItems = 50) {
  if (!probeJson || !Array.isArray(probeJson.entries)) return [];
  const cap = Math.min(100, Math.max(1, Number(maxItems) || 50));
  const result = [];

  for (let i = 0; i < probeJson.entries.length && result.length < cap; i++) {
    const entry = probeJson.entries[i];
    if (isUnavailableEntry(entry)) continue;

    let entryUrl = entry.webpage_url || entry.url || '';
    let useParentPlaylistIndex = false;

    if (platform?.id === 'youtube') {
      if (entryUrl && !entryUrl.startsWith('http://') && !entryUrl.startsWith('https://')) {
        entryUrl = `https://www.youtube.com/watch?v=${entry.id || entryUrl}`;
      } else if (!entryUrl && entry.id) {
        entryUrl = `https://www.youtube.com/watch?v=${entry.id}`;
      }
    } else if (!entryUrl || !entryUrl.startsWith('http')) {
      entryUrl = sourceUrl;
      useParentPlaylistIndex = true;
    } else if (entryUrl === sourceUrl) {
      useParentPlaylistIndex = true;
    }

    result.push({
      playlistIndex: Number(entry.playlist_index) || i + 1,
      id: entry.id || `item-${i + 1}`,
      title: String(entry.title || `Video ${result.length + 1}`).trim(),
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      uploader: entry.uploader || entry.channel || probeJson.uploader || probeJson.channel || '',
      duration: Number(entry.duration) > 0 ? Math.round(Number(entry.duration)) : 0,
      upload_date: entry.upload_date || probeJson.upload_date || null,
      height: Number(entry.height) || 0,
      url: entryUrl,
      useParentPlaylistIndex,
    });
  }

  return result;
}

export function detectSocialAdultContent(info, rawTitle = '', rawDesc = '') {
  const combined = `${rawTitle || ''} ${rawDesc || ''} ${info?.title || ''} ${info?.description || ''}`;
  if (/🔞|#nsfw|\bnsfw\b|\bnsfwtwt\b/i.test(combined)) {
    return true;
  }
  try {
    return Boolean(heuristicParseFilename(combined).is_adult);
  } catch {
    return false;
  }
}

function estimateFormatBytes(fmt, durationSec = 0) {
  if (!fmt) return 0;
  const explicit = Number(fmt.filesize || fmt.filesize_approx || 0);
  if (explicit > 0) return explicit;
  const tbr = Number(fmt.tbr || fmt.vbr || fmt.abr || 0);
  const dur = Number(durationSec || 0);
  if (tbr > 0 && dur > 0) {
    return Math.round((tbr * 1000 * dur) / 8);
  }
  return 0;
}

/**
 * Selects a direct progressive HTTP/HTTPS MP4 format (already muxed video+audio) that can be
 * streamed straight into GCS with ZERO /tmp disk/RAM usage (critical for multi-GB videos on Cloud Run).
 * Only picks progressive when it matches the top available <=1080p resolution (e.g. Twitter/X, IG, FB),
 * OR when a >=720p progressive stream avoids exceeding safe Cloud Run tmpfs headroom on huge videos.
 */
export function selectDirectProgressiveFormat(info) {
  if (!info || typeof info !== 'object') return null;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const dur = Number(info.duration) || 0;

  if (formats.length === 0) {
    if (
      info.url &&
      (info.protocol === 'https' || info.protocol === 'http') &&
      String(info.ext || '').toLowerCase() === 'mp4' &&
      info.vcodec !== 'none' &&
      info.acodec !== 'none'
    ) {
      return {
        url: info.url,
        ext: 'mp4',
        height: Number(info.height) || 0,
        tbr: Number(info.tbr) || 0,
        filesize: estimateFormatBytes(info, dur),
        http_headers: info.http_headers || {},
      };
    }
    return null;
  }

  let maxAvailHeight = 0;
  let maxSplitEstBytes = 0;
  for (const f of formats) {
    if (!f || f.vcodec === 'none') continue;
    const h = Number(f.height) || 0;
    if (h > 0 && h <= 1080 && h > maxAvailHeight) {
      maxAvailHeight = h;
    }
    if (h > 0 && h <= 1080 && f.acodec === 'none') {
      maxSplitEstBytes = Math.max(maxSplitEstBytes, estimateFormatBytes(f, dur));
    }
  }

  const progressiveCandidates = formats
    .filter((f) => {
      if (!f || !f.url) return false;
      const proto = String(f.protocol || '').toLowerCase();
      if (proto !== 'https' && proto !== 'http') return false;
      if (String(f.ext || '').toLowerCase() !== 'mp4') return false;
      if (f.vcodec === 'none' || f.acodec === 'none') return false;
      const h = Number(f.height) || 0;
      if (h > 1080) return false;
      return true;
    })
    .sort((a, b) => {
      const hDiff = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (hDiff !== 0) return hDiff;
      const tDiff = (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
      if (tDiff !== 0) return tDiff;
      return estimateFormatBytes(b, dur) - estimateFormatBytes(a, dur);
    });

  if (progressiveCandidates.length === 0) return null;

  const best = progressiveCandidates[0];
  const bestHeight = Number(best.height) || 0;
  const targetHeight = maxAvailHeight > 0 ? Math.min(1080, maxAvailHeight) : bestHeight;

  if (bestHeight >= targetHeight && bestHeight > 0) {
    return best;
  }
  // If top quality is split DASH/HLS exceeding safe Cloud Run tmpfs size, prefer >=720p direct stream
  if (bestHeight >= 720 && maxSplitEstBytes > TMPFS_SAFE_BYTES) {
    return best;
  }
  return null;
}

/**
 * For very large split DASH streams (> 1.35 GiB, e.g. multi-hour 1080p YouTube videos) where
 * writing to Cloud Run tmpfs would OOM, selects direct HTTPS video + audio URLs to mux straight to GCS via FFmpeg pipe.
 */
export function selectLargeSplitHttpsFormats(info) {
  if (!info || !Array.isArray(info.formats)) return null;
  const dur = Number(info.duration) || 0;

  const videoCandidates = info.formats
    .filter((f) => {
      if (!f || !f.url) return false;
      const proto = String(f.protocol || '').toLowerCase();
      if (proto !== 'https' && proto !== 'http') return false;
      if (!f.vcodec || f.vcodec === 'none') return false;
      if (f.acodec && f.acodec !== 'none') return false;
      const h = Number(f.height) || 0;
      return h > 0 && h <= 1080;
    })
    .sort((a, b) => {
      const hDiff = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (hDiff !== 0) return hDiff;
      const mp4Diff = (b.ext === 'mp4' ? 1 : 0) - (a.ext === 'mp4' ? 1 : 0);
      if (mp4Diff !== 0) return mp4Diff;
      return (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
    });

  const audioCandidates = info.formats
    .filter((f) => {
      if (!f || !f.url) return false;
      const proto = String(f.protocol || '').toLowerCase();
      if (proto !== 'https' && proto !== 'http') return false;
      if (f.vcodec && f.vcodec !== 'none') return false;
      if (!f.acodec || f.acodec === 'none') return false;
      return true;
    })
    .sort((a, b) => {
      const m4aDiff = (b.ext === 'm4a' || b.ext === 'mp4' ? 1 : 0) - (a.ext === 'm4a' || a.ext === 'mp4' ? 1 : 0);
      if (m4aDiff !== 0) return m4aDiff;
      return (Number(b.abr || b.tbr) || 0) - (Number(a.abr || a.tbr) || 0);
    });

  if (!videoCandidates.length || !audioCandidates.length) return null;
  const bestVideo = videoCandidates[0];
  const bestAudio = audioCandidates[0];
  const estTotal = estimateFormatBytes(bestVideo, dur) + estimateFormatBytes(bestAudio, dur);

  if (estTotal > TMPFS_SAFE_BYTES) {
    return { video: bestVideo, audio: bestAudio, estimatedBytes: estTotal };
  }
  return null;
}

export function buildSocialMediaMetadata({
  info,
  platform,
  customName,
  gcsPath,
  sizeBytes,
  categoryOverride,
  playlistMeta = null,
}) {
  const uploader = info?.uploader || info?.channel || info?.creator || playlistMeta?.uploader || '';
  const rawDesc = typeof info?.description === 'string' ? info.description.trim() : '';
  const shortDesc = rawDesc
    ? rawDesc.replace(/\s+/g, ' ').slice(0, 420)
    : `Ingested from ${platform.label}${uploader ? ` (${uploader})` : ''}.`;

  const height = Number(info?.height) || 0;
  const resolution =
    height >= 2160 ? '2160p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : '720p';

  const cat = String(categoryOverride || '').toLowerCase().trim();
  const isPlaylistItem = Boolean(playlistMeta && playlistMeta.seriesName);
  const rawBaseTitle = isPlaylistItem
    ? `${playlistMeta.seriesName} ${info?.title || ''}`
    : (customName || info?.title || `${platform.label} Video`).trim();
  const isAdult = detectSocialAdultContent(info, rawBaseTitle, rawDesc);

  let effectiveType;
  if (isAdult && !isPlaylistItem) {
    effectiveType = 'movie';
  } else if (isPlaylistItem) {
    effectiveType =
      cat === 'series'
        ? 'series'
        : cat === 'documentary'
          ? 'documentary'
          : 'others';
  } else {
    effectiveType =
      cat === 'documentary'
        ? 'documentary'
        : cat === 'movie'
          ? 'movie'
          : cat === 'series'
            ? 'series'
            : 'others';
  }

  const genres = isAdult
    ? ['Adult']
    : effectiveType === 'documentary'
      ? ['Documentary', platform.label]
      : effectiveType === 'series'
        ? [platform.label, 'Series']
        : ['Others', platform.label];

  const tags = isAdult ? ['Private', '18+', platform.label, resolution] : [platform.label, resolution];
  if (isPlaylistItem) {
    tags.push('Playlist');
  }
  if (!isAdult) {
    if (effectiveType === 'documentary') {
      tags.push('Documentary');
    } else if (effectiveType === 'others') {
      tags.push('Others');
    }
    if (uploader) {
      tags.push(String(uploader).slice(0, 32));
    }
  }

  if (isPlaylistItem) {
    const season = Number(playlistMeta.season) || 1;
    const episode = Number(playlistMeta.episode) || 1;
    const epCode = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const itemTitle = (info?.title || `Video ${episode}`).trim();
    const seriesName = playlistMeta.seriesName.trim();
    const seriesPlot =
      playlistMeta.seriesPlot ||
      `${platform.label} playlist${uploader ? ` by ${uploader}` : ''}${playlistMeta.totalEpisodes ? ` (${playlistMeta.totalEpisodes} videos)` : ''}.`;

    return {
      id: crypto.createHash('md5').update(gcsPath).digest('hex'),
      filename: path.basename(gcsPath),
      gcs_path: gcsPath,
      title: `${seriesName} - ${epCode}: ${itemTitle}`,
      type: effectiveType,
      series_name: seriesName,
      season,
      episode,
      year: parseUploadYear(info?.upload_date),
      plot: isAdult ? 'Private Media content.' : shortDesc,
      series_plot: seriesPlot,
      genres: Array.from(new Set(genres)),
      tags: Array.from(new Set(tags)),
      poster_url: null,
      backdrop_url: null,
      duration: Number(info?.duration) > 0 ? Math.round(Number(info.duration)) : 0,
      size_bytes: sizeBytes || 0,
      resolution,
      video_codec: 'h264',
      audio_codec: 'aac',
      is_adult: isAdult,
    };
  }

  const rawTitle = (customName || info?.title || `${platform.label} Video`).trim();
  return {
    id: crypto.createHash('md5').update(gcsPath).digest('hex'),
    filename: path.basename(gcsPath),
    gcs_path: gcsPath,
    title: rawTitle,
    type: effectiveType,
    series_name: effectiveType === 'series' ? rawTitle : null,
    season: null,
    episode: null,
    year: parseUploadYear(info?.upload_date),
    plot: isAdult ? 'Private Media content.' : shortDesc,
    series_plot: null,
    genres: Array.from(new Set(genres)),
    tags: Array.from(new Set(tags)),
    poster_url: null,
    backdrop_url: null,
    duration: Number(info?.duration) > 0 ? Math.round(Number(info.duration)) : 0,
    size_bytes: sizeBytes || 0,
    resolution,
    video_codec: 'h264',
    audio_codec: 'aac',
    is_adult: isAdult,
  };
}

async function runSingleYtDlpDownload({
  runner,
  targetUrl,
  itemDir,
  cookiePath,
  platform,
  useParentPlaylistIndex = false,
  playlistIndex = null,
  onProgress,
  onChildProcess,
  isCancelled,
  statusPrefix = '',
  progressStart = 5,
  progressSpan = 80,
}) {
  fs.mkdirSync(itemDir, { recursive: true });
  const outTemplate = path.join(itemDir, 'media.%(ext)s');

  await new Promise((resolve, reject) => {
    const baseArgs = buildBaseArgs(cookiePath, { allowPlaylist: useParentPlaylistIndex });
    const playlistArgs =
      useParentPlaylistIndex && playlistIndex ? ['--playlist-items', String(playlistIndex)] : [];

    const args = [
      ...runner.prefixArgs,
      ...baseArgs,
      ...playlistArgs,
      '-f',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--merge-output-format',
      'mp4',
      '--newline',
      '--progress-template',
      'download:KODIMI_PROG|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s',
      '-o',
      outTemplate,
      targetUrl,
    ];

    const child = spawn(runner.cmd, args, { windowsHide: true });
    onChildProcess(child);

    let stderrTail = '';
    let lineBuf = '';

    const handleChunk = (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const parsed = parseProgressLine(line.trim());
        if (parsed) {
          const scaledProg =
            parsed.progress !== null
              ? Math.min(99, Math.round((progressStart + (parsed.progress / 100) * progressSpan) * 10) / 10)
              : undefined;
          onProgress({
            ...(scaledProg !== undefined ? { progress: scaledProg } : {}),
            ...(parsed.downloaded_bytes !== null ? { downloaded_bytes: parsed.downloaded_bytes } : {}),
            ...(parsed.total_bytes !== null && parsed.total_bytes > 0 ? { total_bytes: parsed.total_bytes } : {}),
            ...(parsed.speed !== null ? { speed: parsed.speed } : {}),
            status_text: `${statusPrefix}Downloading from ${platform.label}...`,
          });
        } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
          onProgress({
            progress: Math.min(99, Math.round((progressStart + progressSpan * 0.96) * 10) / 10),
            speed: 0,
            status_text: `${statusPrefix}Merging audio & video (FFmpeg)...`,
          });
        }
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-1200);
      handleChunk(d);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      onChildProcess(null);
      if (isCancelled()) {
        return reject(new Error('Download cancelled or paused'));
      }
      if (code !== 0) {
        const hint =
          stderrTail.includes('Sign in') || stderrTail.includes('login')
            ? `${platform.label} requested authentication (refresh YT_DLP_COOKIES_B64 if cookies expired).`
            : stderrTail.trim().split('\n').slice(-2).join(' ') || `yt-dlp exited with code ${code}`;
        return reject(new Error(hint));
      }
      resolve();
    });
  });

  const files = fs
    .readdirSync(itemDir)
    .filter((f) => f !== 'cookies.txt' && !f.endsWith('.part') && !f.endsWith('.ytdl'))
    .map((f) => ({ name: f, full: path.join(itemDir, f), size: fs.statSync(path.join(itemDir, f)).size }))
    .sort((a, b) => b.size - a.size);

  if (files.length === 0 || files[0].size === 0) {
    throw new Error(`No video file was produced from ${platform.label} link`);
  }

  return files[0];
}

async function uploadLocalFileToGcs({
  localFilePath,
  gcsPath,
  sizeBytes,
  ext,
  onProgress,
  isCancelled,
  statusText,
  progressStart = 86,
  progressSpan = 13,
}) {
  await new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localFilePath);
    const writeStream = createWriteStream(gcsPath, {
      contentType: ext === '.mp4' ? 'video/mp4' : 'application/octet-stream',
    });
    let uploaded = 0;
    let lastTick = Date.now();
    let lastBytes = 0;

    readStream.on('data', (chunk) => {
      if (isCancelled()) {
        readStream.destroy();
        writeStream.destroy();
        return;
      }
      uploaded += chunk.length;
      const now = Date.now();
      const elapsed = (now - lastTick) / 1000;
      if (elapsed >= 0.7) {
        const speed = Math.round((uploaded - lastBytes) / elapsed);
        const pct = Math.min(99, Math.round((progressStart + (uploaded / sizeBytes) * progressSpan) * 10) / 10);
        onProgress({
          downloaded_bytes: uploaded,
          total_bytes: sizeBytes,
          progress: pct,
          speed,
          status_text: statusText,
        });
        lastTick = now;
        lastBytes = uploaded;
      }
    });

    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });
}

/**
 * Streams a direct progressive HTTP/HTTPS MP4 URL straight into Google Cloud Storage
 * with ZERO /tmp disk/RAM footprint (prevents Cloud Run tmpfs OOM on multi-GB videos).
 */
async function streamDirectFormatToGcs({
  format,
  gcsPath,
  onProgress,
  onAbortController = () => {},
  isCancelled,
  statusText,
  progressStart = 5,
  progressSpan = 94,
}) {
  const controller = new AbortController();
  onAbortController(controller);

  const reqHeaders = {
    'User-Agent':
      format.http_headers?.['User-Agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...(format.http_headers || {}),
  };

  try {
    const response = await axios({
      method: 'get',
      url: format.url,
      headers: reqHeaders,
      responseType: 'stream',
      signal: controller.signal,
      timeout: 60000,
      maxRedirects: 5,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const headerLen = parseInt(response.headers?.['content-length'] || '0', 10);
    const totalBytes = headerLen > 0 ? headerLen : Number(format.filesize || format.filesize_approx || 0);
    const contentType = response.headers?.['content-type'] || 'video/mp4';

    onProgress({
      gcs_path: gcsPath,
      total_bytes: totalBytes,
      progress: Math.round(progressStart * 10) / 10,
      status_text: statusText,
    });

    const downloadedBytes = await new Promise((resolve, reject) => {
      const readStream = response.data;
      const writeStream = createWriteStream(gcsPath, {
        contentType: contentType.startsWith('video/') ? contentType : 'video/mp4',
      });

      let received = 0;
      let lastTick = Date.now();
      let lastBytes = 0;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { readStream.destroy(); } catch (_) {}
        try { writeStream.destroy(); } catch (_) {}
        reject(err);
      };

      readStream.on('data', (chunk) => {
        if (isCancelled()) {
          try { controller.abort(); } catch (_) {}
          fail(new Error('Download cancelled or paused'));
          return;
        }
        received += chunk.length;
        const now = Date.now();
        const elapsed = (now - lastTick) / 1000;
        if (elapsed >= 0.7) {
          const speed = Math.round((received - lastBytes) / elapsed);
          const ratio = totalBytes > 0 ? Math.min(0.995, received / totalBytes) : 0.5;
          const pct = Math.min(99, Math.round((progressStart + ratio * progressSpan) * 10) / 10);
          onProgress({
            downloaded_bytes: received,
            total_bytes: totalBytes > 0 ? totalBytes : received,
            progress: pct,
            speed,
            status_text: statusText,
          });
          lastTick = now;
          lastBytes = received;
        }
      });

      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve(received);
      });

      readStream.pipe(writeStream);
    });

    if (downloadedBytes <= 0) {
      throw new Error('Direct progressive stream produced 0 bytes');
    }

    return { sizeBytes: downloadedBytes };
  } finally {
    onAbortController(null);
  }
}

/**
 * Streams a very large split DASH video+audio pair directly through FFmpeg into GCS
 * (fragmented MP4 pipe, ZERO /tmp disk/RAM usage).
 */
async function streamSplitDashToGcs({
  split,
  gcsPath,
  onProgress,
  onChildProcess = () => {},
  isCancelled,
  statusText,
  progressStart = 5,
  progressSpan = 94,
}) {
  const formatHeaders = (hdrs) => {
    if (!hdrs || typeof hdrs !== 'object') return null;
    const lines = Object.entries(hdrs)
      .filter(([k, v]) => k && v != null && !/^(host|connection|accept-encoding)$/i.test(k))
      .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, '')}`);
    return lines.length ? `${lines.join('\r\n')}\r\n` : null;
  };

  const vHdr = formatHeaders(split.video.http_headers);
  const aHdr = formatHeaders(split.audio.http_headers);

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...(vHdr ? ['-headers', vHdr] : []),
    '-i', split.video.url,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...(aHdr ? ['-headers', aHdr] : []),
    '-i', split.audio.url,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];

  const totalEst = Number(split.estimatedBytes) || 0;
  onProgress({
    gcs_path: gcsPath,
    total_bytes: totalEst,
    progress: Math.round(progressStart * 10) / 10,
    status_text: statusText,
  });

  const sizeBytes = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffArgs, { windowsHide: true });
    onChildProcess(child);

    const writeStream = createWriteStream(gcsPath, { contentType: 'video/mp4' });
    let uploaded = 0;
    let lastTick = Date.now();
    let lastBytes = 0;
    let stderrTail = '';
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      onChildProcess(null);
      try { child.kill('SIGKILL'); } catch (_) {}
      try { writeStream.destroy(); } catch (_) {}
      reject(err);
    };

    child.stdout.on('data', (chunk) => {
      if (isCancelled()) {
        fail(new Error('Download cancelled or paused'));
        return;
      }
      uploaded += chunk.length;
      const now = Date.now();
      const elapsed = (now - lastTick) / 1000;
      if (elapsed >= 0.7) {
        const speed = Math.round((uploaded - lastBytes) / elapsed);
        const ratio = totalEst > 0 ? Math.min(0.99, uploaded / totalEst) : 0.5;
        const pct = Math.min(99, Math.round((progressStart + ratio * progressSpan) * 10) / 10);
        onProgress({
          downloaded_bytes: uploaded,
          total_bytes: Math.max(totalEst, uploaded),
          progress: pct,
          speed,
          status_text: statusText,
        });
        lastTick = now;
        lastBytes = uploaded;
      }
    });

    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1000);
    });

    child.on('error', fail);
    writeStream.on('error', fail);

    let ffExited = false;
    let ffCode = 0;
    let gcsFinished = false;

    const checkDone = () => {
      if (settled || !ffExited || !gcsFinished) return;
      settled = true;
      onChildProcess(null);
      if (ffCode !== 0 || uploaded === 0) {
        reject(new Error(stderrTail.trim() || `FFmpeg split-stream pipe exited with code ${ffCode}`));
      } else {
        resolve(uploaded);
      }
    };

    child.on('close', (code) => {
      ffExited = true;
      ffCode = code ?? 1;
      if (ffCode !== 0 && !gcsFinished) {
        fail(new Error(stderrTail.trim() || `FFmpeg split-stream pipe exited with code ${ffCode}`));
        return;
      }
      checkDone();
    });

    writeStream.on('finish', () => {
      gcsFinished = true;
      checkDone();
    });

    child.stdout.pipe(writeStream);
  });

  return { sizeBytes };
}

/**
 * Downloads a single video OR a full playlist/multi-video collection from YouTube, Instagram,
 * Twitter/X, Reddit, LinkedIn, or Facebook via yt-dlp -> FFmpeg MP4 -> GCS.
 * For playlists, downloads sequentially one video at a time (immediately clearing tmpfs after
 * each GCS upload) and invokes `onEpisodeReady` after each item so episodes become playable live.
 */
export async function downloadSocialMediaToGcs({
  id,
  url,
  customName = '',
  category = '',
  playlist = 'auto',
  maxItems = 50,
  onProgress = () => {},
  onChildProcess = () => {},
  onAbortController = () => {},
  onEpisodeReady = null,
  isCancelled = () => false,
}) {
  const platform = detectSocialPlatform(url);
  if (!platform) {
    throw new Error('URL is not a recognized social media platform');
  }

  const runner = resolveYtDlpRunner();
  if (!runner) {
    throw new Error('yt-dlp is not installed on this server. Install yt-dlp to enable social media ingestion.');
  }

  const intent = detectPlaylistIntent(url);
  const shouldProbePlaylist =
    playlist === true || (playlist === 'auto' && intent.isExplicitPlaylist);
  const effectiveMaxItems = Math.min(100, Math.max(1, Number(maxItems) || 50));

  const workDir = path.join(os.tmpdir(), `kodimi-social-${id}`);
  fs.mkdirSync(workDir, { recursive: true });
  const cookiePath = writeTempCookiesIfConfigured(workDir);

  try {
    if (shouldProbePlaylist) {
      onProgress({
        status_text: `Scanning ${platform.label} playlist entries...`,
        progress: 2,
      });

      let playlistProbe = null;
      try {
        playlistProbe = await runYtDlpJsonProbe(runner, url, cookiePath, {
          flatPlaylist: true,
          maxItems: effectiveMaxItems,
        });
      } catch (probeErr) {
        console.warn(`[SocialDownloader] Flat playlist probe warning for ${platform.label}:`, probeErr.message);
      }

      if (isCancelled()) {
        throw new Error('Download cancelled or paused');
      }

      const entries = normalizePlaylistEntries(playlistProbe, url, platform, effectiveMaxItems);

      if (entries.length >= 2) {
        const playlistTitle = (
          customName ||
          playlistProbe?.title ||
          `${platform.label} Playlist`
        ).trim();
        const safePlaylistDir = sanitizeFilenameSegment(playlistTitle, `${platform.label}-Playlist`);
        const playlistUploader = playlistProbe?.uploader || playlistProbe?.channel || entries[0]?.uploader || '';
        const rawPlaylistDesc =
          typeof playlistProbe?.description === 'string' && playlistProbe.description.trim()
            ? playlistProbe.description.replace(/\s+/g, ' ').trim().slice(0, 460)
            : `${platform.label} playlist${playlistUploader ? ` by ${playlistUploader}` : ''} (${entries.length} videos).`;

        const shortJobId = String(id).slice(0, 6);
        const completedItems = [];
        let skippedCount = 0;
        let cumulativeBytes = 0;

        onProgress({
          name: `${playlistTitle} (${entries.length} videos)`,
          status_text: `Found ${entries.length} videos in "${playlistTitle}". Starting download...`,
          progress: 4,
        });

        for (let idx = 0; idx < entries.length; idx++) {
          if (isCancelled()) {
            throw new Error('Download cancelled or paused');
          }

          const entry = entries[idx];
          const epNum = idx + 1;
          const totalCount = entries.length;
          const epCode = `S01E${String(epNum).padStart(2, '0')}`;
          const itemBasePct = 4 + (idx / totalCount) * 95;
          const itemTotalSpan = 95 / totalCount;
          const dlSpan = itemTotalSpan * 0.78;
          const uploadSpan = itemTotalSpan * 0.2;
          const statusPrefix = `[${epNum}/${totalCount}] `;
          const itemDir = path.join(workDir, `ep-${epNum}`);

          try {
            onProgress({
              progress: Math.round(itemBasePct * 10) / 10,
              speed: 0,
              status_text: `${statusPrefix}Preparing "${entry.title.slice(0, 48)}"...`,
            });

            // Optionally fetch full item metadata if description/upload_date missing (fast, non-fatal)
            let fullEntryInfo = entry;
            if (!entry.useParentPlaylistIndex && (!entry.description || !entry.height)) {
              try {
                const probed = await runYtDlpJsonProbe(runner, entry.url, cookiePath, { flatPlaylist: false });
                if (probed && typeof probed === 'object') {
                  fullEntryInfo = { ...entry, ...probed, title: probed.title || entry.title };
                }
              } catch (_) {}
            }

            if (isCancelled()) {
              throw new Error('Download cancelled or paused');
            }

            const safeItemTitle = sanitizeFilenameSegment(fullEntryInfo.title || `Video-${epNum}`, `Video-${epNum}`);
            let gcsPath = `Social/${platform.label}/${safePlaylistDir}/${epCode}-${safeItemTitle}-${shortJobId}.mp4`;
            let uploadedSize = 0;

            const directProg = !entry.useParentPlaylistIndex ? selectDirectProgressiveFormat(fullEntryInfo) : null;
            const largeSplit = !directProg && !entry.useParentPlaylistIndex ? selectLargeSplitHttpsFormats(fullEntryInfo) : null;

            let streamedDirectly = false;
            if (directProg) {
              try {
                if (directProg.height) fullEntryInfo = { ...fullEntryInfo, height: directProg.height };
                const res = await streamDirectFormatToGcs({
                  format: directProg,
                  gcsPath,
                  onProgress,
                  onAbortController,
                  isCancelled,
                  statusText: `${statusPrefix}Streaming "${safeItemTitle.slice(0, 44)}" directly to GCS...`,
                  progressStart: itemBasePct,
                  progressSpan: itemTotalSpan * 0.96,
                });
                uploadedSize = res.sizeBytes;
                streamedDirectly = true;
              } catch (directErr) {
                if (isCancelled()) throw directErr;
                console.warn(`[SocialDownloader] Direct stream fallback for playlist item #${epNum}: ${directErr.message}`);
              }
            } else if (largeSplit) {
              try {
                if (largeSplit.video.height) fullEntryInfo = { ...fullEntryInfo, height: largeSplit.video.height };
                const res = await streamSplitDashToGcs({
                  split: largeSplit,
                  gcsPath,
                  onProgress,
                  onChildProcess,
                  isCancelled,
                  statusText: `${statusPrefix}Streaming HD "${safeItemTitle.slice(0, 40)}" directly to GCS...`,
                  progressStart: itemBasePct,
                  progressSpan: itemTotalSpan * 0.96,
                });
                uploadedSize = res.sizeBytes;
                streamedDirectly = true;
              } catch (splitErr) {
                if (isCancelled()) throw splitErr;
                console.warn(`[SocialDownloader] Split stream fallback for playlist item #${epNum}: ${splitErr.message}`);
              }
            }

            if (!streamedDirectly) {
              const mediaFile = await runSingleYtDlpDownload({
                runner,
                targetUrl: entry.useParentPlaylistIndex ? url : entry.url,
                itemDir,
                cookiePath,
                platform,
                useParentPlaylistIndex: entry.useParentPlaylistIndex,
                playlistIndex: entry.playlistIndex,
                onProgress,
                onChildProcess,
                isCancelled,
                statusPrefix,
                progressStart: itemBasePct,
                progressSpan: dlSpan,
              });

              if (isCancelled()) {
                throw new Error('Download cancelled or paused');
              }

              const ext = path.extname(mediaFile.name) || '.mp4';
              gcsPath = `Social/${platform.label}/${safePlaylistDir}/${epCode}-${safeItemTitle}-${shortJobId}${ext}`;

              onProgress({
                gcs_path: gcsPath,
                progress: Math.min(99, Math.round((itemBasePct + dlSpan) * 10) / 10),
                speed: 0,
                status_text: `${statusPrefix}Uploading "${safeItemTitle.slice(0, 44)}" to GCS...`,
              });

              await uploadLocalFileToGcs({
                localFilePath: mediaFile.full,
                gcsPath,
                sizeBytes: mediaFile.size,
                ext,
                onProgress,
                isCancelled,
                statusText: `${statusPrefix}Uploading "${safeItemTitle.slice(0, 44)}" to GCS...`,
                progressStart: itemBasePct + dlSpan,
                progressSpan: uploadSpan,
              });
              uploadedSize = mediaFile.size;
            }

            cumulativeBytes += uploadedSize;

            const metadata = buildSocialMediaMetadata({
              info: fullEntryInfo,
              platform,
              customName: '',
              gcsPath,
              sizeBytes: uploadedSize,
              categoryOverride: category,
              playlistMeta: {
                seriesName: playlistTitle,
                seriesPlot: rawPlaylistDesc,
                uploader: playlistUploader,
                season: 1,
                episode: epNum,
                totalEpisodes: totalCount,
              },
            });

            const epResult = {
              gcsPath,
              sizeBytes: uploadedSize,
              platform,
              metadata,
              epNum,
              totalCount,
            };

            completedItems.push(epResult);

            if (typeof onEpisodeReady === 'function') {
              await onEpisodeReady(epResult);
            }

            onProgress({
              progress: Math.min(99, Math.round((itemBasePct + itemTotalSpan) * 10) / 10),
              speed: 0,
              status_text: `${statusPrefix}Indexed "${safeItemTitle.slice(0, 44)}" ✓`,
            });
          } catch (itemErr) {
            if (isCancelled()) {
              throw itemErr;
            }
            skippedCount++;
            console.warn(
              `[SocialDownloader] Skipping playlist item ${epNum}/${totalCount} ("${entry.title}"): ${itemErr.message}`
            );
            onProgress({
              status_text: `${statusPrefix}Skipped unavailable video (${skippedCount} skipped)...`,
            });
          } finally {
            // Reclaim Cloud Run tmpfs immediately after EVERY episode!
            try {
              fs.rmSync(itemDir, { recursive: true, force: true });
            } catch (_) {}
          }
        }

        if (completedItems.length === 0) {
          throw new Error(`No playable videos could be downloaded from ${platform.label} playlist`);
        }

        return {
          isPlaylist: true,
          playlistName: playlistTitle,
          platform,
          items: completedItems,
          skippedCount,
          totalBytes: cumulativeBytes,
          sizeBytes: cumulativeBytes,
          gcsPath: completedItems[0].gcsPath,
          metadata: completedItems[0].metadata,
        };
      }
      // If flat probe returned <= 1 item, fall through cleanly to single-video path!
    }

    // ---- Single Video Download Path ----
    onProgress({
      status_text: `Fetching ${platform.label} video info...`,
      progress: 2,
    });

    let info = null;
    try {
      info = await runYtDlpJsonProbe(runner, url, cookiePath, { flatPlaylist: false });
    } catch (probeErr) {
      console.warn(`[SocialDownloader] Metadata probe warning for ${platform.label}:`, probeErr.message);
    }

    if (isCancelled()) {
      throw new Error('Download cancelled or paused');
    }

    const displayTitle = sanitizeFilenameSegment(customName || info?.title || `${platform.label}-video-${Date.now()}`);
    const shortId = String(id).slice(0, 6);
    let gcsPath = `Social/${platform.label}/${displayTitle}-${shortId}.mp4`;
    let finalSizeBytes = 0;

    // Zero-RAM streaming path: stream direct progressive MP4 (e.g. Twitter/X 1080p) or large split DASH straight to GCS
    const directProg = selectDirectProgressiveFormat(info);
    const largeSplit = !directProg ? selectLargeSplitHttpsFormats(info) : null;
    let streamedDirectly = false;

    if (directProg) {
      if (directProg.height) info = { ...(info || {}), height: directProg.height };
      onProgress({
        name: `${displayTitle}.mp4`,
        gcs_path: gcsPath,
        status_text: `Streaming ${platform.label} video directly to GCS...`,
        progress: 5,
        total_bytes: Number(directProg.filesize || directProg.filesize_approx || info?.filesize || 0),
      });
      try {
        console.log(
          `[SocialDownloader] Direct zero-tmpfs streaming ${platform.label} format ${directProg.format_id || 'progressive'} (${directProg.height || '?'}p) -> gs://.../${gcsPath}`
        );
        const streamed = await streamDirectFormatToGcs({
          format: directProg,
          gcsPath,
          onProgress,
          onAbortController,
          isCancelled,
          statusText: `Streaming ${platform.label} video directly to GCS...`,
          progressStart: 5,
          progressSpan: 94,
        });
        finalSizeBytes = streamed.sizeBytes;
        streamedDirectly = true;
      } catch (directErr) {
        if (isCancelled()) throw directErr;
        console.warn(`[SocialDownloader] Direct stream failed (${directErr.message}); falling back to yt-dlp`);
      }
    } else if (largeSplit) {
      if (largeSplit.video.height) info = { ...(info || {}), height: largeSplit.video.height };
      onProgress({
        name: `${displayTitle}.mp4`,
        gcs_path: gcsPath,
        status_text: `Streaming HD ${platform.label} video directly to GCS...`,
        progress: 5,
        total_bytes: largeSplit.estimatedBytes,
      });
      try {
        console.log(
          `[SocialDownloader] Split-DASH zero-tmpfs FFmpeg pipe (${largeSplit.video.height || '?'}p, ~${Math.round(largeSplit.estimatedBytes / 1048576)}MB) -> gs://.../${gcsPath}`
        );
        const streamed = await streamSplitDashToGcs({
          split: largeSplit,
          gcsPath,
          onProgress,
          onChildProcess,
          isCancelled,
          statusText: `Streaming HD ${platform.label} video directly to GCS...`,
          progressStart: 5,
          progressSpan: 94,
        });
        finalSizeBytes = streamed.sizeBytes;
        streamedDirectly = true;
      } catch (splitErr) {
        if (isCancelled()) throw splitErr;
        console.warn(`[SocialDownloader] Split-DASH pipe failed (${splitErr.message}); falling back to yt-dlp`);
      }
    }

    if (!streamedDirectly) {
      onProgress({
        name: `${displayTitle}.mp4`,
        status_text: `Downloading from ${platform.label}...`,
        progress: 5,
        total_bytes: Number(info?.filesize || info?.filesize_approx || 0),
      });

      const itemDir = path.join(workDir, 'single');
      const mediaFile = await runSingleYtDlpDownload({
        runner,
        targetUrl: url,
        itemDir,
        cookiePath,
        platform,
        onProgress,
        onChildProcess,
        isCancelled,
        progressStart: 5,
        progressSpan: 80,
      });

      const ext = path.extname(mediaFile.name) || '.mp4';
      gcsPath = `Social/${platform.label}/${displayTitle}-${shortId}${ext}`;

      onProgress({
        name: `${displayTitle}${ext}`,
        gcs_path: gcsPath,
        total_bytes: mediaFile.size,
        progress: 86,
        speed: 0,
        status_text: `Uploading ${platform.label} video to GCS...`,
      });

      await uploadLocalFileToGcs({
        localFilePath: mediaFile.full,
        gcsPath,
        sizeBytes: mediaFile.size,
        ext,
        onProgress,
        isCancelled,
        statusText: `Uploading ${platform.label} video to GCS...`,
        progressStart: 86,
        progressSpan: 13,
      });
      finalSizeBytes = mediaFile.size;
    }

    const metadata = buildSocialMediaMetadata({
      info,
      platform,
      customName,
      gcsPath,
      sizeBytes: finalSizeBytes,
      categoryOverride: category,
    });

    return {
      isPlaylist: false,
      gcsPath,
      sizeBytes: finalSizeBytes,
      totalBytes: finalSizeBytes,
      platform,
      metadata,
      items: [{ gcsPath, sizeBytes: finalSizeBytes, platform, metadata }],
      skippedCount: 0,
    };
  } finally {
    // Always reclaim Cloud Run tmpfs immediately
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

export default {
  detectSocialPlatform,
  detectPlaylistIntent,
  detectSocialAdultContent,
  selectDirectProgressiveFormat,
  selectLargeSplitHttpsFormats,
  normalizePlaylistEntries,
  buildSocialMediaMetadata,
  resolveYtDlpRunner,
  sanitizeFilenameSegment,
  downloadSocialMediaToGcs,
};
