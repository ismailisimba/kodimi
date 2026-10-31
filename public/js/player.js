/**
 * Kodimi Material 3 Video Player Controller
 * Enhanced with AV1/HEVC Low-Bandwidth Codec Negotiation, Smart 1080p-Low,
 * Debounced Zero-429 Seeking, and Persistent GCS Manual Subtitles (.SRT / .VTT / .ASS)
 */
import { api } from './api.js?v=26';

/**
 * Parses WebVTT (.vtt), SubRip (.srt), or SubStation Alpha (.ass / .ssa) text into sorted cues:
 * [{ start: number, end: number, text: string }, ...]
 */
export function parseSubtitleText(rawText, filename = '') {
  if (!rawText || typeof rawText !== 'string') return [];

  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
  if (lowerName.endsWith('.ass') || lowerName.endsWith('.ssa') || /^\[Events\]/im.test(text)) {
    const cues = [];
    const lines = text.split('\n');
    let inEvents = false;
    let formatCols = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

    const parseAssSec = (t) => {
      const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mins = parseInt(m[2], 10);
      const secs = parseInt(m[3], 10);
      const msStr = m[4].length === 2 ? `${m[4]}0` : m[4].padEnd(3, '0').slice(0, 3);
      return h * 3600 + mins * 60 + secs + parseInt(msStr, 10) / 1000;
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
        if (/\{\\p[1-9]\}/i.test(parts[textIdx])) continue;

        const start = parseAssSec(parts[startIdx]);
        const end = parseAssSec(parts[endIdx]);
        if (start === null || end === null) continue;

        const cueText = cleanAssOverrides(parts[textIdx])
          .replace(/\\N/g, '\n')
          .replace(/\\n/g, '\n')
          .replace(/\\h/g, ' ')
          .trim();

        if (cueText) {
          cues.push({ start, end, text: cueText });
        }
      }
    }

    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  // 2. WebVTT (.vtt) & SubRip (.srt) unified parser (supports '.' or ',' decimals)
  const cues = [];
  const lines = text.split('\n');
  const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

  const parseSec = (h, m, s, ms) => {
    const hours = h ? parseInt(h, 10) : 0;
    const mins = parseInt(m, 10);
    const secs = parseInt(s, 10);
    const millis = parseInt(ms.padEnd(3, '0').slice(0, 3), 10);
    return hours * 3600 + mins * 60 + secs + millis / 1000;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const timeMatch = line.match(timeRegex);
    if (timeMatch) {
      const start = parseSec(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
      const end = parseSec(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);

      let cueText = '';
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        cueText += (cueText ? '\n' : '') + lines[i].trim();
        i++;
      }
      const cleaned = cleanAssOverrides(cueText).trim();
      if (cleaned) {
        cues.push({ start, end, text: cleaned });
      }
    } else {
      i++;
    }
  }

  return cues;
}

/**
 * Escapes arbitrary HTML while preserving safe inline subtitle formatting tags (<i>, <b>, <u>).
 */
export function renderSafeSubtitleHtml(text) {
  if (!text) return '';
  const escaped = text.replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch] || ch));

  return escaped.replace(/&lt;(\/?(?:i|b|u))&gt;/gi, '<$1>');
}

class KodimiPlayer {
  constructor() {
    this.container = document.getElementById('player-container');
    this.video = document.getElementById('player-video');
    this.playBtn = document.getElementById('player-play-btn');
    this.playIcon = document.getElementById('player-play-icon');
    this.progressContainer = document.getElementById('player-progress-container');
    this.progressTooltip = document.getElementById('player-progress-tooltip');
    this.progressBuffer = document.getElementById('player-progress-buffer');
    this.progressFill = document.getElementById('player-progress-fill');
    this.timeDisplay = document.getElementById('player-time-display');
    this.volumeBtn = document.getElementById('player-volume-btn');
    this.volumeIcon = document.getElementById('player-volume-icon');
    this.volumeSlider = document.getElementById('player-volume-slider');
    this.qualityBtn = document.getElementById('player-quality-btn');
    this.qualityLabel = document.getElementById('player-quality-label');
    this.qualityMenu = document.getElementById('player-quality-menu');
    this.fullscreenBtn = document.getElementById('player-fullscreen-btn');
    this.fullscreenIcon = document.getElementById('player-fullscreen-icon');
    this.subtitlesBtn = document.getElementById('player-subtitles-btn');
    this.subtitlesIcon = document.getElementById('player-subtitles-icon');
    this.subtitlesMenu = document.getElementById('player-subtitles-menu');
    this.subtitlesOptions = document.getElementById('player-subtitles-options');
    this.subtitleDisplay = document.getElementById('player-subtitle-display');
    this.subtitleUploadBtn = document.getElementById('player-subtitle-upload-btn');
    this.subtitleUploadText = document.getElementById('player-subtitle-upload-text');
    this.subtitleFileInput = document.getElementById('player-subtitle-file-input');
    this.subOffsetMinusBtn = document.getElementById('player-sub-offset-minus');
    this.subOffsetResetBtn = document.getElementById('player-sub-offset-reset');
    this.subOffsetPlusBtn = document.getElementById('player-sub-offset-plus');
    this.loader = document.getElementById('player-loader');
    this.loaderText = document.querySelector('.player-loader-text');
    this.backBtn = document.getElementById('player-back-btn');
    this.titleDisplay = document.getElementById('player-title-display');
    this.overlayTop = document.getElementById('player-overlay-top');
    this.overlayBottom = document.getElementById('player-overlay-bottom');

    this.currentMedia = null;
    this.selectedQuality = 'original';
    this.totalDuration = 0;
    this.seekTimeOffset = 0;
    this.isPendingSeek = false;
    this.pendingSeekTarget = 0;
    this.seekDebounceTimer = null;
    this.streamSessionId = null;
    this.retryTimer = null;
    this.hasRetriedCurrentLoad = false;

    this.supportedCodecs = this.detectSupportedCodecs();
    this.codecPreference = localStorage.getItem('kodimi_codec_pref') || 'auto';

    this.currentVolume = 1;
    this.isMuted = false;
    this.subtitlesEnabled = false;
    this.availableSubtitles = [];
    this.activeSubtitleId = 'off';
    this.subtitleCues = [];
    this.subtitleOffsetSec = 0;
    this.controlsTimeout = null;
    this.progressInterval = null;
    this.hls = null;
    this.liveTranscodeQuality = null;

    this.initEvents();
  }

  detectSupportedCodecs() {
    const checkMime = (mime) => {
      try {
        if (typeof window !== 'undefined' && window.MediaSource && typeof window.MediaSource.isTypeSupported === 'function') {
          if (window.MediaSource.isTypeSupported(mime)) return true;
        }
        if (this.video && typeof this.video.canPlayType === 'function') {
          const res = this.video.canPlayType(mime);
          return res === 'probably';
        }
      } catch (_) {}
      return false;
    };

    const av1 =
      checkMime('video/mp4; codecs="av01.0.08M.08,mp4a.40.2"') ||
      checkMime('video/mp4; codecs="av01.0.05M.08"');
    const hevc =
      checkMime('video/mp4; codecs="hvc1.1.6.L120.90,mp4a.40.2"') ||
      checkMime('video/mp4; codecs="hvc1.1.6.L93.B0"');

    return { av1, hevc, h264: true };
  }

  getAutoDetectedCodec() {
    if (this.supportedCodecs.av1) return 'av1';
    if (this.supportedCodecs.hevc) return 'hevc';
    return 'h264';
  }

  getEffectiveCodec() {
    if (this.codecPreference === 'av1' && this.supportedCodecs.av1) return 'av1';
    if (this.codecPreference === 'hevc' && this.supportedCodecs.hevc) return 'hevc';
    if (this.codecPreference === 'h264') return 'h264';
    return this.getAutoDetectedCodec();
  }

  setCodecPreference(pref) {
    this.codecPreference = pref;
    try {
      localStorage.setItem('kodimi_codec_pref', pref);
    } catch (_) {}
    this.renderVodQualityMenu();

    // If currently streaming a transcoded profile, seamlessly reload with the selected codec
    if (!this.isLive && this.currentMedia && this.selectedQuality !== 'original' && this.selectedQuality !== 'direct') {
      const cur = this.getEffectiveCurrentTime();
      this.updateQualityBadgeLabel();
      this.seekTimeOffset = cur;
      const newUrl = this.buildVodStreamUrl(this.selectedQuality, cur);
      this.loadVideoSource(newUrl, cur);
    }
  }

  buildVodStreamUrl(quality, timeSec) {
    return api.getStreamUrl(this.currentMedia.id, quality, timeSec, {
      codec: this.getEffectiveCodec(),
      sid: this.streamSessionId,
      av1: this.supportedCodecs.av1,
      hevc: this.supportedCodecs.hevc,
    });
  }

  initEvents() {
    // Video Events
    this.video.addEventListener('play', () => {
      this.updatePlayIcon(true);
      this.hideLoader();
    });
    this.video.addEventListener('pause', () => this.updatePlayIcon(false));
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.video.addEventListener('loadedmetadata', () => {
      this.isPendingSeek = false;
      this.hasRetriedCurrentLoad = false;
      this.onMetadataLoaded();
      this.hideLoader();
    });
    this.video.addEventListener('click', () => this.togglePlay());

    // Video Buffering & Loading Listeners
    this.video.addEventListener('loadstart', () => this.showLoader('Loading stream...'));
    this.video.addEventListener('waiting', () => this.showLoader('Buffering...'));
    this.video.addEventListener('seeking', () => this.showLoader('Seeking...'));
    this.video.addEventListener('canplay', () => {
      this.isPendingSeek = false;
      this.hideLoader();
    });
    this.video.addEventListener('playing', () => {
      this.isPendingSeek = false;
      this.hasRetriedCurrentLoad = false;
      this.hideLoader();
    });
    this.video.addEventListener('seeked', () => this.hideLoader());

    // Graceful Codec Fallback & Transient Network Retry
    this.video.addEventListener('error', () => {
      if (this.isLive || !this.currentMedia || this.isPendingSeek) return;
      const mediaErr = this.video.error;
      if (!mediaErr) return;

      const cur = this.getEffectiveCurrentTime();
      const activeCodec = this.getEffectiveCodec();

      // Decode / format unsupported fallback: AV1 -> HEVC -> H.264
      if (
        (mediaErr.code === 3 || mediaErr.code === 4) &&
        this.selectedQuality !== 'original' &&
        this.selectedQuality !== 'direct' &&
        activeCodec !== 'h264'
      ) {
        if (activeCodec === 'av1') {
          this.supportedCodecs.av1 = false;
        } else if (activeCodec === 'hevc') {
          this.supportedCodecs.hevc = false;
        }
        const fallbackCodec = this.getEffectiveCodec();
        console.warn(`[Player] Codec ${activeCodec.toUpperCase()} decode failed, falling back to ${fallbackCodec.toUpperCase()}...`);
        this.updateQualityBadgeLabel();
        this.renderVodQualityMenu();
        const retryUrl = this.buildVodStreamUrl(this.selectedQuality, cur);
        this.loadVideoSource(retryUrl, cur);
        return;
      }

      // Single transient network retry after 1.5s
      if (!this.hasRetriedCurrentLoad && mediaErr.code === 2) {
        this.hasRetriedCurrentLoad = true;
        this.showLoader('Reconnecting stream...');
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          if (!this.currentMedia || this.isLive) return;
          const retryUrl = this.buildVodStreamUrl(this.selectedQuality, cur);
          this.loadVideoSource(retryUrl, cur);
        }, 1500);
      }
    });

    // Controls Action Listeners
    this.playBtn.addEventListener('click', () => this.togglePlay());
    document.getElementById('player-rewind-btn').addEventListener('click', () => this.skip(-10));
    document.getElementById('player-forward-btn').addEventListener('click', () => this.skip(10));

    // Progress Bar Scrubber
    this.progressContainer.addEventListener('click', (e) => this.seek(e));

    this.progressContainer.addEventListener('mousemove', (e) => {
      const rect = this.progressContainer.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = this.getEffectiveDuration();
      const hoverTime = pos * dur;

      if (this.progressTooltip) {
        this.progressTooltip.textContent = this.formatTime(hoverTime);
        this.progressTooltip.style.left = `${pos * 100}%`;
      }
    });

    // Volume
    this.volumeSlider.addEventListener('input', (e) => this.setVolume(parseFloat(e.target.value)));
    this.volumeBtn.addEventListener('click', () => this.toggleMute());

    // Subtitles Menu & Controls
    if (this.subtitlesBtn) {
      this.subtitlesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.qualityMenu) this.qualityMenu.classList.remove('open');
        this.subtitlesMenu.classList.toggle('open');
      });
    }
    if (this.subtitlesMenu) {
      this.subtitlesMenu.addEventListener('click', (e) => e.stopPropagation());
    }

    if (this.subtitleUploadBtn && this.subtitleFileInput) {
      this.subtitleUploadBtn.addEventListener('click', () => {
        this.subtitleFileInput.click();
      });
      this.subtitleFileInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
          this.handleManualSubtitleFile(file);
        }
        this.subtitleFileInput.value = '';
      });
    }

    if (this.subOffsetMinusBtn) {
      this.subOffsetMinusBtn.addEventListener('click', () => this.adjustSubtitleOffset(-0.5));
    }
    if (this.subOffsetResetBtn) {
      this.subOffsetResetBtn.addEventListener('click', () => this.adjustSubtitleOffset(0, true));
    }
    if (this.subOffsetPlusBtn) {
      this.subOffsetPlusBtn.addEventListener('click', () => this.adjustSubtitleOffset(0.5));
    }

    // Quality Menu
    this.qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.subtitlesMenu) this.subtitlesMenu.classList.remove('open');
      this.qualityMenu.classList.toggle('open');
    });
    if (this.qualityMenu) {
      this.qualityMenu.addEventListener('click', (e) => e.stopPropagation());
    }

    document.addEventListener('click', () => {
      if (this.qualityMenu) this.qualityMenu.classList.remove('open');
      if (this.subtitlesMenu) this.subtitlesMenu.classList.remove('open');
    });

    // Fullscreen
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.backBtn.addEventListener('click', () => this.close());

    // Activity auto-hide
    this.container.addEventListener('mousemove', () => this.onUserActivity());

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  open(media, initialTime = 0) {
    this.cancelPendingTimers();
    this.isLive = false;
    this.liveTranscodeQuality = null;
    this.currentMedia = media;
    this.streamSessionId = `sid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.selectedQuality = 'original';
    this.updateQualityBadgeLabel();
    this.renderVodQualityMenu();
    this.titleDisplay.textContent = media.title;
    this.totalDuration = (media && media.duration > 0) ? media.duration : 0;
    this.seekTimeOffset = initialTime;
    this.isPendingSeek = false;
    this.pendingSeekTarget = initialTime;
    this.hasRetriedCurrentLoad = false;
    this.subtitlesEnabled = false;
    this.activeSubtitleId = 'off';
    this.subtitleOffsetSec = 0;
    this.updateSubtitleOffsetLabel();
    this.updateSubtitlesIcon(false);

    // If total duration is unknown, probe it asynchronously
    if (this.totalDuration <= 0 && media && media.id) {
      api.getMediaDuration(media.id).then((res) => {
        if (res && res.duration > 0 && this.currentMedia && this.currentMedia.id === media.id) {
          this.totalDuration = res.duration;
          this.currentMedia.duration = res.duration;
          this.onTimeUpdate();
        }
      }).catch(() => {});
    }

    // Remove existing subtitle tracks
    this.clearSubtitleTracks();

    // Fetch and populate available subtitle tracks (custom GCS + embedded)
    this.loadSubtitleTracks(media.id);

    this.container.classList.remove('player-hidden');
    document.body.style.overflow = 'hidden';

    // Start with Universal AAC Original Stream
    const url = this.buildVodStreamUrl('original', initialTime);
    this.loadVideoSource(url, initialTime);

    this.onUserActivity();

    // Start periodic progress sync (every 15s to minimize background HTTP & DB load)
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    this.progressInterval = setInterval(() => {
      if (this.currentMedia && !this.isLive) {
        const cur = this.getEffectiveCurrentTime();
        const dur = this.getEffectiveDuration();
        if (dur > 0 && !this.video.paused) {
          api.saveProgress(this.currentMedia.id, cur, dur, 0).catch(() => {});
        }
      }
    }, 15000);
  }

  openLive(channel) {
    this.cancelPendingTimers();
    this.isLive = true;
    this.liveTranscodeQuality = null;
    this.currentMedia = {
      ...channel,
      is_live: true,
      title: channel.name,
    };
    this.selectedQuality = 'live';
    this.qualityLabel.textContent = channel.resolution || 'LIVE';
    this.renderLiveQualityMenu();
    this.titleDisplay.innerHTML = `
      <span class="live-badge" style="margin-right: 8px;">🔴 LIVE</span>
      <span>${channel.name}</span>
      ${channel.currentProgram ? `<span style="font-size: 13px; opacity: 0.8; font-weight: 400; margin-left: 8px;">• ${channel.currentProgram.title}</span>` : ''}
    `;
    this.totalDuration = 0;
    this.seekTimeOffset = 0;
    this.isPendingSeek = false;
    this.subtitlesEnabled = false;
    this.activeSubtitleId = 'off';
    this.updateSubtitlesIcon(false);
    this.clearSubtitleTracks();

    if (this.timeDisplay) {
      this.timeDisplay.innerHTML = `<span style="color: #ff3b30; font-weight: 800;">🔴 LIVE BROADCAST</span>`;
    }
    if (this.progressFill) {
      this.progressFill.style.width = '100%';
    }

    this.container.classList.remove('player-hidden');
    document.body.style.overflow = 'hidden';

    this.loadLiveSource(channel.streamUrl);
    this.onUserActivity();
  }

  cancelPendingTimers() {
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  abortVideoStream() {
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch (_) {}
  }

  destroyHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch (err) {
        console.warn('[Player] Error destroying Hls instance:', err);
      }
      this.hls = null;
    }
  }

  loadLiveSource(streamUrl) {
    this.destroyHls();
    this.video.pause();
    this.video.volume = this.currentVolume;
    this.video.muted = this.isMuted;

    this.showLoader(`Connecting to ${this.currentMedia?.name || 'Live Channel'}...`);

    const isMixedContent = window.location.protocol === 'https:' && streamUrl.startsWith('http:');
    const initialUrl = (isMixedContent || streamUrl.includes('primetv.cc.cd'))
      ? api.getLiveProxyUrl(streamUrl)
      : streamUrl;

    this.startHlsStream(initialUrl, streamUrl);
  }

  startHlsStream(playUrl, originalStreamUrl) {
    this.destroyHls();

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        manifestLoadingTimeOut: 12000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 12000,
        fragLoadingTimeOut: 15000,
      });
      this.hls = hls;

      hls.loadSource(playUrl);
      hls.attachMedia(this.video);

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        console.log('[Live TV] HLS manifest parsed successfully with', this.hls?.levels?.length, 'levels');
        this.renderLiveQualityMenu();
        this.hideLoader();
        this.video.play().catch((err) => {
          console.warn('[Live TV] Autoplay prevented:', err.message);
        });
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
        if (this.hls && this.hls.currentLevel === -1 && this.hls.levels && this.hls.levels[data.level]) {
          const activeLevel = this.hls.levels[data.level];
          if (activeLevel && activeLevel.height) {
            this.qualityLabel.textContent = `AUTO (${activeLevel.height}P)`;
          }
        }
      });

      hls.on(window.Hls.Events.ERROR, (event, data) => {
        console.warn('[HLS.js Event Error]:', data.type, data.details, 'Fatal:', data.fatal);
        if (data.fatal) {
          switch (data.type) {
            case window.Hls.ErrorTypes.NETWORK_ERROR:
              if (playUrl === originalStreamUrl) {
                console.log('[Live TV] Direct stream network error, switching to Kodimi proxy...');
                this.startHlsStream(api.getLiveProxyUrl(originalStreamUrl), originalStreamUrl);
                return;
              }
              console.error('[Live TV] Fatal network error on stream proxy.');
              this.destroyHls();
              this.showLoader('Live stream temporarily unavailable');
              break;
            case window.Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[Live TV] Fatal media error, recovering...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[Live TV] Fatal unrecoverable HLS error:', data.details);
              this.destroyHls();
              this.showLoader('Live stream playback error');
              break;
          }
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = playUrl;
      const playPromise = this.video.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          if (playUrl === originalStreamUrl) {
            console.warn('[Live TV] Native HLS failed, trying proxy...');
            this.video.src = api.getLiveProxyUrl(originalStreamUrl);
            this.video.play().catch(() => {
              this.showLoader('Live stream unavailable');
            });
          } else {
            this.showLoader('Live stream unavailable');
          }
        });
      }
    } else {
      this.showLoader('HLS playback is not supported on this browser');
    }
  }

  loadVideoSource(url, startTime = 0) {
    this.destroyHls();
    this.abortVideoStream();
    this.video.src = url;

    // Preserve audio settings
    this.video.volume = this.currentVolume;
    this.video.muted = this.isMuted;

    if (this.selectedQuality === 'direct' && startTime > 0) {
      this.video.currentTime = startTime;
    }

    this.video.play().catch(() => {});
  }

  close() {
    this.cancelPendingTimers();
    this.destroyHls();

    if (this.currentMedia && !this.isLive) {
      const cur = this.getEffectiveCurrentTime();
      const dur = this.getEffectiveDuration();
      if (dur > 0) {
        api.saveProgress(this.currentMedia.id, cur, dur, 0).catch(() => {});
      }
    }

    this.isLive = false;
    this.liveTranscodeQuality = null;
    this.isPendingSeek = false;
    this.streamSessionId = null;

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    this.abortVideoStream();
    this.clearSubtitleTracks();
    this.container.classList.add('player-hidden');
    document.body.style.overflow = '';
    this.currentMedia = null;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    window.dispatchEvent(new CustomEvent('kodimi_player_closed'));
  }

  togglePlay() {
    if (this.video.paused) {
      const p = this.video.play();
      if (p !== undefined) {
        p.catch(() => {});
      }
    } else {
      this.video.pause();
    }
  }

  updatePlayIcon(isPlaying) {
    this.playIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
  }

  getEffectiveCurrentTime() {
    if (this.selectedQuality === 'direct') {
      return this.video.currentTime || 0;
    }
    if (this.isPendingSeek) {
      return this.pendingSeekTarget;
    }
    return this.seekTimeOffset + (this.video.currentTime || 0);
  }

  getEffectiveDuration() {
    if (this.totalDuration > 0) {
      return this.totalDuration;
    }
    const rawDur = this.video.duration;
    if (this.selectedQuality === 'direct' && Number.isFinite(rawDur) && rawDur > 0) {
      this.totalDuration = rawDur;
      return rawDur;
    }
    return this.totalDuration || 1;
  }

  skip(seconds) {
    if (this.isLive || !this.currentMedia) return;
    const cur = this.getEffectiveCurrentTime();
    const dur = this.getEffectiveDuration();
    const target = Math.max(0, Math.min(dur, cur + seconds));
    this.seekToTime(target);
    this.onUserActivity();
  }

  seek(e) {
    if (this.isLive || !this.currentMedia) return;
    const rect = this.progressContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = this.getEffectiveDuration();
    const targetTime = pos * dur;
    this.seekToTime(targetTime);
  }

  seekToTime(targetTime) {
    if (!this.currentMedia) return;

    if (this.selectedQuality === 'direct') {
      this.video.currentTime = targetTime;
      this.onTimeUpdate();
      return;
    }

    // Immediate UI feedback (0ms) while coalescing rapid seeks into a single FFmpeg request (280ms debounce)
    this.isPendingSeek = true;
    this.pendingSeekTarget = targetTime;
    this.seekTimeOffset = targetTime;
    this.hasRetriedCurrentLoad = false;
    this.showLoader(`Seeking to ${this.formatTime(targetTime)}...`);
    this.onTimeUpdate();

    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
    }

    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = null;
      if (!this.currentMedia || this.isLive) return;
      const finalTarget = this.pendingSeekTarget;
      this.seekTimeOffset = finalTarget;
      const newUrl = this.buildVodStreamUrl(this.selectedQuality, finalTarget);
      this.loadVideoSource(newUrl, finalTarget);
    }, 280);
  }

  updateQualityBadgeLabel() {
    const codecBadge = this.getEffectiveCodec().toUpperCase();
    const labelMap = {
      'original': 'ORIGINAL (AAC)',
      'direct': 'ORIGINAL (DIRECT)',
      '1080p-low': `1080P LOW (${codecBadge})`,
      '720p': `720P (${codecBadge})`,
      '480p': `480P (${codecBadge})`,
      '360p': `360P (${codecBadge})`,
      '240p': `240P (${codecBadge})`,
      '144p': `144P (${codecBadge})`,
    };
    this.qualityLabel.textContent = labelMap[this.selectedQuality] || this.selectedQuality.toUpperCase();
  }

  changeQuality(quality) {
    if (this.isLive || !this.currentMedia || quality === this.selectedQuality) return;

    this.cancelPendingTimers();
    const currentTime = this.getEffectiveCurrentTime();
    this.selectedQuality = quality;
    this.isPendingSeek = false;
    this.hasRetriedCurrentLoad = false;

    this.updateQualityBadgeLabel();
    this.qualityMenu.classList.remove('open');
    this.renderVodQualityMenu();

    if (quality === 'direct') {
      this.seekTimeOffset = 0;
      const newUrl = this.buildVodStreamUrl('direct', currentTime);
      this.loadVideoSource(newUrl, currentTime);
    } else {
      this.seekTimeOffset = currentTime;
      const newUrl = this.buildVodStreamUrl(quality, currentTime);
      this.loadVideoSource(newUrl, currentTime);
    }
  }

  renderVodQualityMenu() {
    if (!this.qualityMenu) return;

    const activeCodec = this.getEffectiveCodec().toUpperCase();
    const autoCodec = this.getAutoDetectedCodec().toUpperCase();

    const vodOptions = [
      { id: 'original', label: 'Original (Universal AAC)', note: 'Native video • Synced stereo AAC' },
      { id: '1080p-low', label: '1080p HD (Low Data)', note: `${activeCodec} ~200MB/ep • Smart Copy if optimized` },
      { id: '720p', label: '720p HD (Low Data)', note: `${activeCodec} ~115MB/ep • Capped below source` },
      { id: '480p', label: '480p SD', note: `${activeCodec} ~68MB/ep` },
      { id: '360p', label: '360p (Mobile)', note: `${activeCodec} ~44MB/ep` },
      { id: '240p', label: '240p (Low Bandwidth)', note: `${activeCodec} ~28MB/ep` },
      { id: '144p', label: '144p (Data Saver)', note: `${activeCodec} ~18MB/ep` },
      { id: 'direct', label: 'Original (Direct Raw)', note: 'HTTP 206 byte-range passthrough' },
    ];

    let html = `
      <div style="padding: 6px 16px; font-size: 11px; font-weight: 700; color: var(--md-sys-color-outline); text-transform: uppercase;">
        Adaptive Resolutions
      </div>
    `;

    vodOptions.forEach((opt) => {
      const isSelected = this.selectedQuality === opt.id;
      html += `
        <button class="quality-option ${isSelected ? 'active' : ''}" data-quality="${opt.id}">
          <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
            <span>${opt.label}</span>
            <span style="font-size: 10px; opacity: 0.65; font-weight: 400; margin-top: 1px;">${opt.note}</span>
          </div>
          ${isSelected ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;
    });

    html += `
      <div class="codec-menu-footer">
        <div class="subtitle-offset-row">
          <span class="subtitle-offset-label">Codec</span>
          <div class="codec-pill-row">
            <button type="button" class="codec-pill-btn ${this.codecPreference === 'auto' ? 'active' : ''}" data-codec-pref="auto" title="Auto-detected: ${autoCodec}">
              Auto
            </button>
            <button type="button" class="codec-pill-btn ${this.codecPreference === 'av1' ? 'active' : ''}" data-codec-pref="av1" ${!this.supportedCodecs.av1 ? 'disabled title="AV1 not supported by this browser"' : 'title="AV1 (Lowest bandwidth)"'}>
              AV1
            </button>
            <button type="button" class="codec-pill-btn ${this.codecPreference === 'hevc' ? 'active' : ''}" data-codec-pref="hevc" ${!this.supportedCodecs.hevc ? 'disabled title="HEVC not supported by this browser"' : 'title="HEVC / x265"'}>
              HEVC
            </button>
            <button type="button" class="codec-pill-btn ${this.codecPreference === 'h264' ? 'active' : ''}" data-codec-pref="h264" title="H.264 (Maximum device compatibility)">
              H.264
            </button>
          </div>
        </div>
      </div>
    `;

    this.qualityMenu.innerHTML = html;

    this.qualityMenu.querySelectorAll('.quality-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        const quality = e.currentTarget.dataset.quality;
        this.changeQuality(quality);
      });
    });

    this.qualityMenu.querySelectorAll('.codec-pill-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const pref = e.currentTarget.dataset.codecPref;
        this.setCodecPreference(pref);
      });
    });
  }

  renderLiveQualityMenu() {
    if (!this.qualityMenu) return;

    const headerHtml = `
      <div style="padding: 6px 16px; font-size: 11px; font-weight: 700; color: var(--md-sys-color-outline); text-transform: uppercase;">
        Live Stream Resolution
      </div>
    `;

    if (this.hls && this.hls.levels && this.hls.levels.length > 1) {
      const currentLvl = this.hls.currentLevel;

      let optionsHtml = `
        ${headerHtml}
        <button class="quality-option ${currentLvl === -1 ? 'active' : ''}" data-live-level="-1">
          <span>Auto (Adaptive Bitrate)</span>
          ${currentLvl === -1 ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;

      const indexedLevels = this.hls.levels
        .map((lvl, idx) => ({ ...lvl, index: idx }))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      indexedLevels.forEach((lvl) => {
        const isSelected = currentLvl === lvl.index;
        const label = lvl.height ? `${lvl.height}p` : `Level ${lvl.index + 1}`;
        const bitrateKbps = lvl.bitrate ? ` (${Math.round(lvl.bitrate / 1000)} kbps)` : '';
        optionsHtml += `
          <button class="quality-option ${isSelected ? 'active' : ''}" data-live-level="${lvl.index}">
            <span>${label}${bitrateKbps}</span>
            ${isSelected ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
          </button>
        `;
      });

      this.qualityMenu.innerHTML = optionsHtml;

      this.qualityMenu.querySelectorAll('.quality-option').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const levelIdx = parseInt(e.currentTarget.dataset.liveLevel, 10);
          this.setLiveQualityLevel(levelIdx);
          this.qualityMenu.classList.remove('open');
        });
      });
      return;
    }

    const activeQuality = this.liveTranscodeQuality || 'source';
    const sourceRes = this.currentMedia?.resolution || '1080P';

    const transcodeOptions = [
      { id: 'source', label: `${sourceRes} (Source Broadcast - Free)`, note: 'Native direct live feed' },
      { id: '720p', label: '720p HD (Live Transcode)', note: 'Downscaled on-the-fly' },
      { id: '480p', label: '480p SD (Live Transcode)', note: 'Low data usage' },
      { id: '360p', label: '360p (Live Transcode)', note: 'Data saver' },
    ];

    let optionsHtml = headerHtml;
    transcodeOptions.forEach((opt) => {
      const isSelected = activeQuality === opt.id;
      optionsHtml += `
        <button class="quality-option ${isSelected ? 'active' : ''}" data-fixed-quality="${opt.id}">
          <div style="display: flex; flex-direction: column; align-items: flex-start;">
            <span>${opt.label}</span>
            <span style="font-size: 10px; opacity: 0.65; margin-top: 1px;">${opt.note}</span>
          </div>
          ${isSelected ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;
    });

    this.qualityMenu.innerHTML = optionsHtml;

    this.qualityMenu.querySelectorAll('.quality-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const quality = e.currentTarget.dataset.fixedQuality;
        this.setFixedLiveQuality(quality);
        this.qualityMenu.classList.remove('open');
      });
    });
  }

  setLiveQualityLevel(levelIndex) {
    if (!this.hls) return;

    this.hls.currentLevel = levelIndex;

    if (levelIndex === -1) {
      this.qualityLabel.textContent = 'AUTO';
    } else {
      const lvl = this.hls.levels[levelIndex];
      this.qualityLabel.textContent = lvl && lvl.height ? `${lvl.height}P` : `LVL ${levelIndex + 1}`;
    }

    this.renderLiveQualityMenu();
  }

  setFixedLiveQuality(quality) {
    if (!this.currentMedia) return;

    if (quality === 'source' || quality === '1080p') {
      this.liveTranscodeQuality = null;
      this.qualityLabel.textContent = this.currentMedia.resolution || '1080P';
      this.renderLiveQualityMenu();
      this.loadLiveSource(this.currentMedia.streamUrl);
      return;
    }

    this.liveTranscodeQuality = quality;
    this.qualityLabel.textContent = `${quality.toUpperCase()} (LIVE)`;
    this.renderLiveQualityMenu();

    this.destroyHls();
    this.video.pause();
    this.showLoader(`Starting Live ${quality.toUpperCase()} Transcode...`);

    const transcodeUrl = api.getLiveTranscodeUrl(this.currentMedia.streamUrl, quality);
    this.video.src = transcodeUrl;
    this.video.load();
    this.video.play().catch((err) => {
      console.warn('[Live Transcode Play Warning]:', err.message);
      this.showLoader('Live stream temporarily unavailable');
    });
  }

  showLoader(text = 'Buffering Stream...') {
    if (this.loader) {
      if (this.loaderText) this.loaderText.textContent = text;
      this.loader.style.display = 'flex';
    }
  }

  hideLoader() {
    if (this.loader) {
      this.loader.style.display = 'none';
    }
  }

  async loadSubtitleTracks(mediaId) {
    if (!this.subtitlesOptions) return;
    this.subtitlesOptions.innerHTML = `
      <button class="quality-option active" data-track-id="off">
        <span>Off</span>
        <span class="material-symbols-outlined" style="font-size: 16px;">check</span>
      </button>
      <div style="padding: 8px 16px; font-size: 11px; color: var(--md-sys-color-outline);">Scanning tracks...</div>
    `;

    try {
      const res = await api.getSubtitleTracks(mediaId);
      if (!this.currentMedia || this.currentMedia.id !== mediaId) return;

      this.availableSubtitles = (res.tracks || []).map((t) => ({
        ...t,
        id: t.id || (t.customId ? t.customId : `embedded_${t.trackIndex}`),
      }));
      this.renderSubtitleTracksList();
    } catch (err) {
      console.warn('Failed to load subtitle tracks:', err);
      this.availableSubtitles = [];
      this.renderSubtitleTracksList();
    }
  }

  renderSubtitleTracksList() {
    if (!this.subtitlesOptions) return;

    const isOff = this.activeSubtitleId === 'off';
    let html = `
      <button class="quality-option ${isOff ? 'active' : ''}" data-track-id="off">
        <span>Off</span>
        ${isOff ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
      </button>
    `;

    if (this.availableSubtitles.length === 0) {
      html += `<div style="padding: 8px 16px; font-size: 11px; color: var(--md-sys-color-outline);">No subtitles yet — upload .SRT/.VTT below</div>`;
    } else {
      this.availableSubtitles.forEach((t) => {
        const isActive = this.activeSubtitleId === t.id;
        const safeLabel = (t.label || 'Subtitle').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
        if (t.isCustom && t.customId) {
          html += `
            <div class="subtitle-track-row">
              <button class="quality-option ${isActive ? 'active' : ''}" data-track-id="${t.id}">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeLabel}</span>
                ${isActive ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
              </button>
              <button type="button" class="subtitle-delete-btn" data-delete-sub="${t.customId}" title="Delete uploaded subtitle from GCS">
                <span class="material-symbols-outlined" style="font-size: 16px;">delete</span>
              </button>
            </div>
          `;
        } else {
          html += `
            <button class="quality-option ${isActive ? 'active' : ''}" data-track-id="${t.id}">
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeLabel}</span>
              ${isActive ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
            </button>
          `;
        }
      });
    }

    this.subtitlesOptions.innerHTML = html;

    this.subtitlesOptions.querySelectorAll('.quality-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        const trackId = e.currentTarget.dataset.trackId;
        this.setSubtitleTrackById(trackId);
        this.subtitlesMenu.classList.remove('open');
      });
    });

    this.subtitlesOptions.querySelectorAll('.subtitle-delete-btn').forEach((delBtn) => {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const subId = e.currentTarget.dataset.deleteSub;
        if (!subId || !this.currentMedia) return;
        try {
          await api.deleteCustomSubtitle(this.currentMedia.id, subId);
          this.availableSubtitles = this.availableSubtitles.filter((t) => t.customId !== subId);
          if (this.activeSubtitleId === subId) {
            this.setSubtitleTrackById('off');
          } else {
            this.renderSubtitleTracksList();
          }
        } catch (err) {
          console.warn('Failed to delete custom subtitle:', err);
        }
      });
    });
  }

  async setSubtitleTrackById(trackId) {
    this.activeSubtitleId = trackId;
    this.clearSubtitleTracks();

    if (!trackId || trackId === 'off') {
      this.activeSubtitleId = 'off';
      this.subtitlesEnabled = false;
      this.updateSubtitlesIcon(false);
      this.updateSubtitleDisplay('');
      this.renderSubtitleTracksList();
      return;
    }

    const track = this.availableSubtitles.find((t) => t.id === trackId);
    if (!track || !this.currentMedia) {
      this.renderSubtitleTracksList();
      return;
    }

    this.subtitlesEnabled = true;
    this.updateSubtitlesIcon(true);
    this.renderSubtitleTracksList();

    const targetMediaId = this.currentMedia.id;
    this.updateSubtitleDisplay('<i>Loading full subtitle track...</i>');

    try {
      const subUrl = track.isCustom
        ? api.getSubtitleUrl(targetMediaId, { customId: track.customId })
        : api.getSubtitleUrl(targetMediaId, { trackIndex: track.trackIndex });

      const res = await fetch(subUrl);
      if (!this.currentMedia || this.currentMedia.id !== targetMediaId || this.activeSubtitleId !== trackId) {
        return;
      }

      if (res.ok) {
        const vttText = await res.text();
        this.subtitleCues = parseSubtitleText(vttText, 'track.vtt');
        console.log(`[Subtitles] Loaded ${this.subtitleCues.length} full-episode cues for ${track.label}`);
        this.updateSubtitles();
      } else {
        this.updateSubtitleDisplay('');
      }
    } catch (err) {
      console.warn('Failed to fetch/parse subtitle track:', err);
      this.updateSubtitleDisplay('');
    }
  }

  async handleManualSubtitleFile(file, targetMedia = this.currentMedia) {
    if (!file || !targetMedia) return;

    try {
      const rawText = await file.text();
      const parsedCues = parseSubtitleText(rawText, file.name);
      if (parsedCues.length === 0) {
        alert('Could not find valid subtitle timestamps in that file (.srt, .vtt, or .ass).');
        return;
      }

      // 1. Activate immediately in player with 0ms interruption if currently watching this item
      const isPlayingTarget = this.currentMedia && this.currentMedia.id === targetMedia.id;
      const tempId = `local_${Date.now()}`;
      const cleanName = file.name.replace(/\.(srt|vtt|ass|ssa)$/i, '').slice(0, 48) || 'Uploaded';

      if (isPlayingTarget) {
        this.subtitleCues = parsedCues;
        this.activeSubtitleId = tempId;
        this.subtitlesEnabled = true;
        this.updateSubtitlesIcon(true);
        this.updateSubtitles();
        if (this.subtitleUploadText) {
          this.subtitleUploadText.textContent = 'Saving to GCS...';
        }
      }

      // 2. Persist permanently to Google Cloud Storage (.subtitles/) + MongoDB
      const res = await api.uploadCustomSubtitle(targetMedia.id, {
        filename: file.name,
        label: cleanName,
        content: rawText,
      });

      if (res && res.track) {
        const savedTrack = { ...res.track, id: res.track.id || res.track.customId };
        if (isPlayingTarget) {
          this.availableSubtitles = [
            savedTrack,
            ...this.availableSubtitles.filter((t) => t.id !== savedTrack.id),
          ];
          this.activeSubtitleId = savedTrack.id;
          this.renderSubtitleTracksList();
          if (this.subtitleUploadText) {
            this.subtitleUploadText.textContent = '✓ Saved to Cloud!';
            setTimeout(() => {
              if (this.subtitleUploadText) {
                this.subtitleUploadText.textContent = 'Upload .SRT / .VTT / .ASS';
              }
            }, 2200);
          }
        }
      }
      return res;
    } catch (err) {
      console.error('Manual subtitle upload error:', err);
      if (this.subtitleUploadText) {
        this.subtitleUploadText.textContent = 'Upload .SRT / .VTT / .ASS';
      }
      alert(`Subtitle upload failed: ${err.message}`);
      return null;
    }
  }

  adjustSubtitleOffset(deltaSec, reset = false) {
    if (reset) {
      this.subtitleOffsetSec = 0;
    } else {
      this.subtitleOffsetSec = Math.round((this.subtitleOffsetSec + deltaSec) * 10) / 10;
    }
    this.updateSubtitleOffsetLabel();
    this.updateSubtitles();
  }

  updateSubtitleOffsetLabel() {
    if (!this.subOffsetResetBtn) return;
    const val = this.subtitleOffsetSec;
    const sign = val > 0 ? '+' : '';
    this.subOffsetResetBtn.textContent = `${sign}${val.toFixed(1)}s`;
  }

  updateSubtitles() {
    if (!this.subtitlesEnabled || this.subtitleCues.length === 0) {
      this.updateSubtitleDisplay('');
      return;
    }

    // Positive offset delays subtitles (shows them later), negative shows them earlier
    const cur = this.getEffectiveCurrentTime() - this.subtitleOffsetSec;
    const activeCues = this.subtitleCues.filter((c) => cur >= c.start && cur <= c.end);

    if (activeCues.length > 0) {
      const combinedText = activeCues.map((c) => c.text).join('\n');
      this.updateSubtitleDisplay(renderSafeSubtitleHtml(combinedText));
    } else {
      this.updateSubtitleDisplay('');
    }
  }

  updateSubtitleDisplay(safeHtml) {
    if (!this.subtitleDisplay) return;
    if (safeHtml) {
      this.subtitleDisplay.innerHTML = safeHtml;
      this.subtitleDisplay.style.display = 'block';
    } else {
      this.subtitleDisplay.innerHTML = '';
      this.subtitleDisplay.style.display = 'none';
    }
  }

  toggleSubtitles() {
    if (!this.currentMedia || this.availableSubtitles.length === 0) return;
    if (this.activeSubtitleId === 'off') {
      this.setSubtitleTrackById(this.availableSubtitles[0].id);
    } else {
      this.setSubtitleTrackById('off');
    }
  }

  clearSubtitleTracks() {
    const existing = document.getElementById('kodimi-sub-track');
    if (existing) existing.remove();
    this.subtitleCues = [];
    this.updateSubtitleDisplay('');
  }

  updateSubtitlesIcon(active) {
    if (this.subtitlesBtn) {
      if (active) {
        this.subtitlesBtn.classList.add('active');
        this.subtitlesIcon.textContent = 'closed_caption';
      } else {
        this.subtitlesBtn.classList.remove('active');
        this.subtitlesIcon.textContent = 'subtitles';
      }
    }
  }

  setVolume(val) {
    this.currentVolume = val;
    this.video.volume = val;
    this.isMuted = val === 0;
    this.video.muted = this.isMuted;
    this.volumeIcon.textContent = val === 0 ? 'volume_off' : 'volume_up';
  }

  toggleMute() {
    this.isMuted = !this.video.muted;
    this.video.muted = this.isMuted;
    this.volumeIcon.textContent = this.isMuted ? 'volume_off' : 'volume_up';
    if (!this.isMuted && this.video.volume === 0) {
      this.setVolume(0.5);
      this.volumeSlider.value = 0.5;
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.container.requestFullscreen().catch(() => {});
      this.fullscreenIcon.textContent = 'fullscreen_exit';
    } else {
      document.exitFullscreen().catch(() => {});
      this.fullscreenIcon.textContent = 'fullscreen';
    }
  }

  onTimeUpdate() {
    if (this.isLive) {
      if (this.timeDisplay) {
        this.timeDisplay.innerHTML = `<span style="color: #ff3b30; font-weight: 800;">🔴 LIVE</span>`;
      }
      return;
    }

    const cur = this.getEffectiveCurrentTime();
    const dur = this.getEffectiveDuration();
    const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
    this.progressFill.style.width = `${pct}%`;
    this.timeDisplay.textContent = `${this.formatTime(cur)} / ${this.formatTime(dur)}`;

    if (!this.isPendingSeek && this.progressBuffer && this.video.buffered && this.video.buffered.length > 0 && dur > 0) {
      try {
        const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
        const effectiveBuffered = this.selectedQuality === 'direct' ? bufferedEnd : this.seekTimeOffset + bufferedEnd;
        const bufPct = Math.min(100, Math.max(0, (effectiveBuffered / dur) * 100));
        this.progressBuffer.style.width = `${bufPct}%`;
      } catch (_) {}
    }

    this.updateSubtitles();
  }

  onMetadataLoaded() {
    if (this.selectedQuality === 'direct') {
      const rawDur = this.video.duration;
      if (Number.isFinite(rawDur) && rawDur > 0) {
        this.totalDuration = rawDur;
      }
    }
    this.onTimeUpdate();
  }

  formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) {
      return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  onUserActivity() {
    this.overlayTop.classList.remove('player-hidden');
    this.overlayBottom.classList.remove('player-hidden');

    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    this.controlsTimeout = setTimeout(() => {
      if (!this.video.paused) {
        this.overlayTop.classList.add('player-hidden');
        this.overlayBottom.classList.add('player-hidden');
      }
    }, 3500);
  }

  onKeyDown(e) {
    if (this.container.classList.contains('player-hidden')) return;
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.skip(-10);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.skip(10);
    } else if (e.key === 'c') {
      e.preventDefault();
      this.toggleSubtitles();
    } else if (e.key === 'f') {
      e.preventDefault();
      this.toggleFullscreen();
    } else if (e.key === 'm') {
      e.preventDefault();
      this.toggleMute();
    } else if (e.key === 'Escape') {
      if (!document.fullscreenElement) {
        this.close();
      }
    }
  }
}

export default KodimiPlayer;
