import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config/env.js';
import { createWriteStream } from '../config/gcs.js';

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

  let effectiveType;
  if (isPlaylistItem) {
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

  const genres =
    effectiveType === 'documentary'
      ? ['Documentary', platform.label]
      : effectiveType === 'series'
        ? [platform.label, 'Series']
        : ['Others', platform.label];

  const tags = [platform.label, resolution];
  if (isPlaylistItem) {
    tags.push('Playlist');
  }
  if (effectiveType === 'documentary') {
    tags.push('Documentary');
  } else if (effectiveType === 'others') {
    tags.push('Others');
  }
  if (uploader) {
    tags.push(String(uploader).slice(0, 32));
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
      plot: shortDesc,
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
      is_adult: false,
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
    plot: shortDesc,
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
    is_adult: false,
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
            const safeItemTitle = sanitizeFilenameSegment(fullEntryInfo.title || `Video-${epNum}`, `Video-${epNum}`);
            const gcsPath = `Social/${platform.label}/${safePlaylistDir}/${epCode}-${safeItemTitle}-${shortJobId}${ext}`;

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

            cumulativeBytes += mediaFile.size;

            const metadata = buildSocialMediaMetadata({
              info: fullEntryInfo,
              platform,
              customName: '',
              gcsPath,
              sizeBytes: mediaFile.size,
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
              sizeBytes: mediaFile.size,
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
    const gcsPath = `Social/${platform.label}/${displayTitle}-${shortId}${ext}`;

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

    const metadata = buildSocialMediaMetadata({
      info,
      platform,
      customName,
      gcsPath,
      sizeBytes: mediaFile.size,
      categoryOverride: category,
    });

    return {
      isPlaylist: false,
      gcsPath,
      sizeBytes: mediaFile.size,
      totalBytes: mediaFile.size,
      platform,
      metadata,
      items: [{ gcsPath, sizeBytes: mediaFile.size, platform, metadata }],
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
  normalizePlaylistEntries,
  buildSocialMediaMetadata,
  resolveYtDlpRunner,
  sanitizeFilenameSegment,
  downloadSocialMediaToGcs,
};
