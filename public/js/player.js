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
    this.controlsTimeout = null;
    this.progressInterval = null;

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

    document.querySelectorAll('.quality-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        const quality = e.currentTarget.dataset.quality;
        this.changeQuality(quality);
      });
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
    this.currentMedia = media;
    this.selectedQuality = 'original';
    this.qualityLabel.textContent = 'ORIGINAL (AAC)';
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

    // Start periodic progress sync
    this.progressInterval = setInterval(() => {
      if (this.currentMedia) {
        const cur = this.getEffectiveCurrentTime();
        const dur = this.getEffectiveDuration();
        if (dur > 0 && !this.video.paused) {
          api.saveProgress(this.currentMedia.id, cur, dur, 0);
        }
      }
    }, 5000);
  }

  loadVideoSource(url, startTime = 0) {
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
    if (this.currentMedia) {
      const cur = this.getEffectiveCurrentTime();
      const dur = this.getEffectiveDuration();
      if (dur > 0) {
        api.saveProgress(this.currentMedia.id, cur, dur, 0);
      }
    }

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    this.video.pause();
    this.video.src = '';
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
      this.video.play();
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
    if (!this.currentMedia || quality === this.selectedQuality) return;

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

    document.querySelectorAll('.quality-option').forEach((opt) => {
      if (opt.dataset.quality === quality) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });

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

  setSubtitleTrack(trackIndex) {
    this.activeSubtitleTrack = trackIndex;
    this.clearSubtitleTracks();

    if (trackIndex === -1) {
      this.subtitlesEnabled = false;
      this.updateSubtitlesIcon(false);
    } else {
      this.subtitlesEnabled = true;
      this.updateSubtitlesIcon(true);

      const track = document.createElement('track');
      track.id = 'kodimi-sub-track';
      track.kind = 'subtitles';
      track.label = 'Subtitles';
      track.src = api.getSubtitleUrl(this.currentMedia.id, trackIndex);
      track.default = true;

      this.video.appendChild(track);
      track.addEventListener('load', () => {
        if (this.video.textTracks && this.video.textTracks[0]) {
          this.video.textTracks[0].mode = 'showing';
        }
      });
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
    if (this.video.textTracks) {
      for (let i = 0; i < this.video.textTracks.length; i++) {
        this.video.textTracks[i].mode = 'disabled';
      }
    }
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
