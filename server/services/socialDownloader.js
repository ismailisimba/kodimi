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

function buildBaseArgs(cookiePath) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
  ];
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }
  return args;
}

function runYtDlpJsonProbe(runner, url, cookiePath) {
  return new Promise((resolve, reject) => {
    const args = [
      ...runner.prefixArgs,
      ...buildBaseArgs(cookiePath),
      '--dump-single-json',
      '--skip-download',
      url,
    ];

    const child = spawn(runner.cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Metadata extraction timed out after 45s'));
    }, 45000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
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

function buildSocialMediaMetadata({ info, platform, customName, gcsPath, sizeBytes, categoryOverride }) {
  const rawTitle = (customName || info?.title || `${platform.label} Video`).trim();
  const uploader = info?.uploader || info?.channel || info?.creator || '';
  const rawDesc = typeof info?.description === 'string' ? info.description.trim() : '';
  const shortDesc = rawDesc
    ? rawDesc.replace(/\s+/g, ' ').slice(0, 420)
    : `Ingested from ${platform.label}${uploader ? ` (${uploader})` : ''}.`;

  const height = Number(info?.height) || 0;
  const resolution =
    height >= 2160 ? '2160p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : '720p';

  const cat = String(categoryOverride || '').toLowerCase().trim();
  const effectiveType = cat === 'documentary' ? 'documentary' : cat === 'movie' ? 'movie' : cat === 'series' ? 'series' : 'others';

  const genres = effectiveType === 'documentary' ? ['Documentary'] : ['Others'];
  const tags = [platform.label, resolution];
  if (effectiveType === 'documentary') {
    tags.push('Documentary');
  } else if (effectiveType === 'others') {
    tags.push('Others');
  }
  if (uploader) {
    tags.push(uploader.slice(0, 32));
  }

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
    genres,
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

/**
 * Downloads a public video from YouTube, Instagram, Twitter/X, Reddit, LinkedIn, or Facebook via yt-dlp,
 * merges into browser-ready MP4 via ffmpeg, streams into GCS, and returns native metadata.
 */
export async function downloadSocialMediaToGcs({
  id,
  url,
  customName = '',
  category = '',
  onProgress = () => {},
  onChildProcess = () => {},
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

  const workDir = path.join(os.tmpdir(), `kodimi-social-${id}`);
  fs.mkdirSync(workDir, { recursive: true });
  const cookiePath = writeTempCookiesIfConfigured(workDir);

  try {
    onProgress({
      status_text: `Fetching ${platform.label} video info...`,
      progress: 2,
    });

    let info = null;
    try {
      info = await runYtDlpJsonProbe(runner, url, cookiePath);
    } catch (probeErr) {
      // Some platforms reject --dump-single-json without download; log and let direct download attempt proceed
      console.warn(`[SocialDownloader] Metadata probe warning for ${platform.label}:`, probeErr.message);
    }

    if (isCancelled()) {
      throw new Error('Download cancelled or paused');
    }

    const displayTitle = sanitizeFilenameSegment(customName || info?.title || `${platform.label}-video-${Date.now()}`);
    const shortId = String(id).slice(0, 6);
    const outTemplate = path.join(workDir, 'media.%(ext)s');

    onProgress({
      name: `${displayTitle}.mp4`,
      status_text: `Downloading from ${platform.label}...`,
      progress: 5,
      total_bytes: Number(info?.filesize || info?.filesize_approx || 0),
    });

    // Run yt-dlp download & FFmpeg MP4 merge
    await new Promise((resolve, reject) => {
      const args = [
        ...runner.prefixArgs,
        ...buildBaseArgs(cookiePath),
        '-f',
        'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '--merge-output-format',
        'mp4',
        '--newline',
        '--progress-template',
        'download:KODIMI_PROG|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s',
        '-o',
        outTemplate,
        url,
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
            // Map download phase to 5%..85% so 85%..100% reflects GCS upload
            const scaledProg = parsed.progress !== null ? Math.round((5 + parsed.progress * 0.8) * 10) / 10 : undefined;
            onProgress({
              ...(scaledProg !== undefined ? { progress: scaledProg } : {}),
              ...(parsed.downloaded_bytes !== null ? { downloaded_bytes: parsed.downloaded_bytes } : {}),
              ...(parsed.total_bytes !== null && parsed.total_bytes > 0 ? { total_bytes: parsed.total_bytes } : {}),
              ...(parsed.speed !== null ? { speed: parsed.speed } : {}),
              status_text: `Downloading from ${platform.label}...`,
            });
          } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
            onProgress({
              progress: 84,
              speed: 0,
              status_text: `Merging ${platform.label} audio & video (FFmpeg)...`,
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
          const hint = stderrTail.includes('Sign in') || stderrTail.includes('login')
            ? `${platform.label} requested authentication (configure YT_DLP_COOKIES_B64 for protected/IP-challenged posts).`
            : stderrTail.trim().split('\n').slice(-2).join(' ') || `yt-dlp exited with code ${code}`;
          return reject(new Error(hint));
        }
        resolve();
      });
    });

    // Locate the downloaded media file in workDir
    const files = fs
      .readdirSync(workDir)
      .filter((f) => f !== 'cookies.txt' && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      .map((f) => ({ name: f, full: path.join(workDir, f), size: fs.statSync(path.join(workDir, f)).size }))
      .sort((a, b) => b.size - a.size);

    if (files.length === 0 || files[0].size === 0) {
      throw new Error(`No video file was produced from ${platform.label} link`);
    }

    const mediaFile = files[0];
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

    // Stream file to Google Cloud Storage
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(mediaFile.full);
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
          const pct = Math.min(99, Math.round((86 + (uploaded / mediaFile.size) * 13) * 10) / 10);
          onProgress({
            downloaded_bytes: uploaded,
            total_bytes: mediaFile.size,
            progress: pct,
            speed,
            status_text: `Uploading ${platform.label} video to GCS...`,
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

    const metadata = buildSocialMediaMetadata({
      info,
      platform,
      customName,
      gcsPath,
      sizeBytes: mediaFile.size,
      categoryOverride: category,
    });

    return {
      gcsPath,
      sizeBytes: mediaFile.size,
      platform,
      metadata,
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
  resolveYtDlpRunner,
  sanitizeFilenameSegment,
  downloadSocialMediaToGcs,
};
