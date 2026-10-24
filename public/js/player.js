/**
 * Kodimi Material 3 Video Player Controller
 * Enhanced with Multi-Resolution Duration Persistence, Audio Compatibility, and WebVTT Subtitles
 */
import { api } from './api.js';

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
    this.currentVolume = 1;
    this.isMuted = false;
    this.subtitlesEnabled = false;
    this.availableSubtitles = [];
    this.activeSubtitleTrack = -1;
    this.subtitleCues = [];
    this.controlsTimeout = null;
    this.progressInterval = null;
    this.hls = null;
    this.liveTranscodeQuality = null;

    this.initEvents();
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
      this.onMetadataLoaded();
      this.hideLoader();
    });
    this.video.addEventListener('click', () => this.togglePlay());

    // Video Buffering & Loading Listeners
    this.video.addEventListener('loadstart', () => this.showLoader('Loading stream...'));
    this.video.addEventListener('waiting', () => this.showLoader('Buffering...'));
    this.video.addEventListener('seeking', () => this.showLoader('Seeking...'));
    this.video.addEventListener('canplay', () => this.hideLoader());
    this.video.addEventListener('playing', () => this.hideLoader());
    this.video.addEventListener('seeked', () => this.hideLoader());

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

    // Subtitles Menu
    if (this.subtitlesBtn) {
      this.subtitlesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.subtitlesMenu.classList.toggle('open');
      });
    }

    // Quality Menu
    this.qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.qualityMenu.classList.toggle('open');
    });

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
    this.isLive = false;
    this.liveTranscodeQuality = null;
    this.liveTranscodeQuality = null;
    this.currentMedia = media;
    this.selectedQuality = 'original';
    this.qualityLabel.textContent = 'ORIGINAL (AAC)';
    this.renderVodQualityMenu();
    this.titleDisplay.textContent = media.title;
    this.totalDuration = (media && media.duration > 0) ? media.duration : 0;
    this.seekTimeOffset = initialTime;
    this.subtitlesEnabled = false;
    this.activeSubtitleTrack = -1;
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

    // Fetch and populate available subtitle tracks
    this.loadSubtitleTracks(media.id);

    this.container.classList.remove('player-hidden');
    document.body.style.overflow = 'hidden';

    // Start with Universal AAC Original Stream
    const url = api.getStreamUrl(media.id, 'original', initialTime);
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
          api.saveProgress(this.currentMedia.id, cur, dur, 0);
        }
      }
    }, 15000);
  }

  openLive(channel) {
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
    this.subtitlesEnabled = false;
    this.activeSubtitleTrack = -1;
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

    // If page is HTTPS and stream is HTTP, route through Kodimi proxy immediately to prevent Mixed Content blocking
    const isMixedContent = window.location.protocol === 'https:' && streamUrl.startsWith('http:');
    // Streams from known sources like primetv.cc.cd require proxying for CORS & relative segment resolution
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
              // If direct stream failed, fallback to Kodimi proxy
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
      // Native HLS for Safari / iOS
      this.video.src = playUrl;
      const playPromise = this.video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
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
    this.video.pause();
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
    this.destroyHls();

    if (this.currentMedia && !this.isLive) {
      const cur = this.getEffectiveCurrentTime();
      const dur = this.getEffectiveDuration();
      if (dur > 0) {
        api.saveProgress(this.currentMedia.id, cur, dur, 0);
      }
    }

    this.isLive = false;
    this.liveTranscodeQuality = null;

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
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
    const cur = this.getEffectiveCurrentTime();
    const dur = this.getEffectiveDuration();
    const target = Math.max(0, Math.min(dur, cur + seconds));
    this.seekToTime(target);
    this.onUserActivity();
  }

  seek(e) {
    const rect = this.progressContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = this.getEffectiveDuration();
    const targetTime = pos * dur;
    this.seekToTime(targetTime);
  }

  seekToTime(targetTime) {
    if (this.selectedQuality === 'direct') {
      this.video.currentTime = targetTime;
    } else {
      // For transcoded or remux streams, restart FFMPEG from target time
      this.seekTimeOffset = targetTime;
      const newUrl = api.getStreamUrl(this.currentMedia.id, this.selectedQuality, targetTime);
      this.loadVideoSource(newUrl, targetTime);
    }
    this.onTimeUpdate();
  }

  changeQuality(quality) {
    if (this.isLive || !this.currentMedia || quality === this.selectedQuality) return;

    const currentTime = this.getEffectiveCurrentTime();
    this.selectedQuality = quality;

    const labelMap = {
      'original': 'ORIGINAL (AAC)',
      'direct': 'ORIGINAL (DIRECT)',
      '720p': '720P HD',
      '480p': '480P SD',
      '360p': '360P',
      '240p': '240P',
      '144p': '144P',
    };
    this.qualityLabel.textContent = labelMap[quality] || quality.toUpperCase();
    this.qualityMenu.classList.remove('open');

    this.renderVodQualityMenu();

    if (quality === 'direct') {
      this.seekTimeOffset = 0;
      const newUrl = api.getStreamUrl(this.currentMedia.id, 'direct', currentTime);
      this.loadVideoSource(newUrl, currentTime);
    } else {
      this.seekTimeOffset = currentTime;
      const newUrl = api.getStreamUrl(this.currentMedia.id, quality, currentTime);
      this.loadVideoSource(newUrl, currentTime);
    }
  }

  renderVodQualityMenu() {
    if (!this.qualityMenu) return;

    const vodOptions = [
      { id: 'original', label: 'Original (Universal AAC)' },
      { id: 'direct', label: 'Original (Direct Raw)' },
      { id: '720p', label: '720p HD' },
      { id: '480p', label: '480p SD' },
      { id: '360p', label: '360p (Mobile)' },
      { id: '240p', label: '240p (Low Bandwidth)' },
      { id: '144p', label: '144p (Data Saver)' },
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
          <span>${opt.label}</span>
          ${isSelected ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;
    });

    this.qualityMenu.innerHTML = html;

    this.qualityMenu.querySelectorAll('.quality-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        const quality = e.currentTarget.dataset.quality;
        this.changeQuality(quality);
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

    // Case 1: Multi-rendition HLS stream (e.g. beIN SPORTS XTRA with 360p, 480p, 720p, 1080p)
    if (this.hls && this.hls.levels && this.hls.levels.length > 1) {
      const currentLvl = this.hls.currentLevel; // -1 = Auto, or 0..N

      let optionsHtml = `
        ${headerHtml}
        <button class="quality-option ${currentLvl === -1 ? 'active' : ''}" data-live-level="-1">
          <span>Auto (Adaptive Bitrate)</span>
          ${currentLvl === -1 ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;

      // Sort from highest height down to lowest
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

    // Case 2: Fixed single-rendition feed (e.g. beIN Sports 1-9 FHD source feed)
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

    // Switch to on-demand real-time FFmpeg live transcode
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
      <button class="quality-option active" data-track="-1">
        <span>Off</span>
        <span class="material-symbols-outlined" style="font-size: 16px;">check</span>
      </button>
      <div style="padding: 8px 16px; font-size: 11px; color: var(--md-sys-color-outline);">Scanning tracks...</div>
    `;

    try {
      const res = await api.getSubtitleTracks(mediaId);
      this.availableSubtitles = res.tracks || [];

      let html = `
        <button class="quality-option ${this.activeSubtitleTrack === -1 ? 'active' : ''}" data-track="-1">
          <span>Off</span>
          ${this.activeSubtitleTrack === -1 ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
        </button>
      `;

      if (this.availableSubtitles.length === 0) {
        html += `<div style="padding: 8px 16px; font-size: 11px; color: var(--md-sys-color-outline);">No embedded subtitles</div>`;
      } else {
        this.availableSubtitles.forEach((t) => {
          const isActive = this.activeSubtitleTrack === t.trackIndex;
          html += `
            <button class="quality-option ${isActive ? 'active' : ''}" data-track="${t.trackIndex}">
              <span>${t.label}</span>
              ${isActive ? '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>' : ''}
            </button>
          `;
        });
      }

      this.subtitlesOptions.innerHTML = html;

      // Attach click listeners to tracks
      this.subtitlesOptions.querySelectorAll('.quality-option').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          const trackIdx = parseInt(e.currentTarget.dataset.track, 10);
          this.setSubtitleTrack(trackIdx);
          this.subtitlesMenu.classList.remove('open');
        });
      });
    } catch (err) {
      console.warn('Failed to load subtitle tracks:', err);
    }
  }

  async setSubtitleTrack(trackIndex) {
    this.activeSubtitleTrack = trackIndex;
    this.clearSubtitleTracks();

    if (trackIndex === -1) {
      this.subtitlesEnabled = false;
      this.updateSubtitlesIcon(false);
      this.updateSubtitleDisplay('');
    } else {
      this.subtitlesEnabled = true;
      this.updateSubtitlesIcon(true);

      try {
        const subUrl = api.getSubtitleUrl(this.currentMedia.id, trackIndex);
        const res = await fetch(subUrl);
        if (res.ok) {
          const vttText = await res.text();
          this.subtitleCues = this.parseWebVTT(vttText);
          console.log(`[Subtitles] Loaded and synchronized ${this.subtitleCues.length} cues for track ${trackIndex}`);
          this.updateSubtitles();
        }
      } catch (err) {
        console.warn('Failed to fetch/parse subtitle track:', err);
      }
    }

    // Update active checkmarks in menu
    if (this.subtitlesOptions) {
      this.subtitlesOptions.querySelectorAll('.quality-option').forEach((btn) => {
        const btnTrack = parseInt(btn.dataset.track, 10);
        if (btnTrack === trackIndex) {
          btn.classList.add('active');
          if (!btn.querySelector('.material-symbols-outlined')) {
            btn.insertAdjacentHTML('beforeend', '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>');
          }
        } else {
          btn.classList.remove('active');
          const check = btn.querySelector('.material-symbols-outlined');
          if (check) check.remove();
        }
      });
    }
  }

  parseWebVTT(vttText) {
    const cues = [];
    const lines = vttText.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const timeMatch = line.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/);
      if (timeMatch) {
        const parseSec = (h, m, s, ms) => {
          const hours = h ? parseInt(h, 10) : 0;
          const mins = parseInt(m, 10);
          const secs = parseInt(s, 10);
          const millis = parseInt(ms, 10);
          return hours * 3600 + mins * 60 + secs + millis / 1000;
        };
        const start = parseSec(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
        const end = parseSec(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);

        let text = '';
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          text += (text ? '\n' : '') + lines[i].trim();
          i++;
        }
        if (text) {
          cues.push({ start, end, text });
        }
      } else {
        i++;
      }
    }
    return cues;
  }

  updateSubtitles() {
    if (!this.subtitlesEnabled || this.subtitleCues.length === 0) {
      this.updateSubtitleDisplay('');
      return;
    }

    const cur = this.getEffectiveCurrentTime();
    const activeCue = this.subtitleCues.find((c) => cur >= c.start && cur <= c.end);
    if (activeCue) {
      this.updateSubtitleDisplay(activeCue.text);
    } else {
      this.updateSubtitleDisplay('');
    }
  }

  updateSubtitleDisplay(text) {
    if (!this.subtitleDisplay) return;
    if (text) {
      this.subtitleDisplay.textContent = text;
      this.subtitleDisplay.style.display = 'block';
    } else {
      this.subtitleDisplay.style.display = 'none';
    }
  }

  toggleSubtitles() {
    if (!this.currentMedia || this.availableSubtitles.length === 0) return;
    if (this.activeSubtitleTrack === -1) {
      this.setSubtitleTrack(0);
    } else {
      this.setSubtitleTrack(-1);
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

    // Update buffer bar visualization relative to total duration
    if (this.progressBuffer && this.video.buffered && this.video.buffered.length > 0 && dur > 0) {
      try {
        const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
        const effectiveBuffered = this.selectedQuality === 'direct' ? bufferedEnd : this.seekTimeOffset + bufferedEnd;
        const bufPct = Math.min(100, Math.max(0, (effectiveBuffered / dur) * 100));
        this.progressBuffer.style.width = `${bufPct}%`;
      } catch (_) {}
    }

    // Synchronize subtitles with effective current playback time
    this.updateSubtitles();
  }

  onMetadataLoaded() {
    // Only direct raw byte-range stream exposes the full media container duration natively
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
