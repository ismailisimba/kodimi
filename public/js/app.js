/**
 * Kodimi Main Application Controller
 * Enhanced with Private Vault (PIN-protected), Material Design 3, & Multi-Resolution Player
 */
import { api, authState, vaultState } from './api.js';
import KodimiPlayer from './player.js';
import {
  renderHeroBanner,
  renderMediaCard,
  renderCarousel,
  renderDownloadItem,
} from './components.js';

class KodimiApp {
  constructor() {
    this.mediaItems = [];
    this.continueWatching = [];
    this.privateItems = [];
    this.activeFilter = 'all';
    this.searchTerm = '';
    this.activeMedia = null;
    this.player = null;
    this.eventSource = null;

    this.initElements();
    this.initPlayer();
    this.initEvents();
    this.checkSessionAndLoad();
  }

  initElements() {
    // Nav & App Bar
    this.topAppBar = document.getElementById('top-app-bar');
    this.searchInput = document.getElementById('search-input');
    this.syncBtn = document.getElementById('sync-btn');
    this.syncIcon = document.getElementById('sync-icon');
    this.fabIngest = document.getElementById('fab-ingest');
    this.logoutBtn = document.getElementById('logout-btn');
    this.navItems = document.querySelectorAll('.nav-item');
    this.navVaultBtn = document.getElementById('nav-vault-btn');

    // Main Content Containers
    this.heroSection = document.getElementById('hero-section');
    this.carouselsContainer = document.getElementById('carousels-container');
    this.gridContainer = document.getElementById('grid-container');
    this.gridTitle = document.getElementById('grid-title');
    this.gridContent = document.getElementById('grid-content');
    this.emptyState = document.getElementById('empty-state');
    this.loadingIndicator = document.getElementById('loading-indicator');

    // Modals
    this.loginModal = document.getElementById('login-modal');
    this.loginForm = document.getElementById('login-form');
    this.loginPassword = document.getElementById('login-password');
    this.loginError = document.getElementById('login-error');

    this.vaultModal = document.getElementById('vault-modal');
    this.vaultForm = document.getElementById('vault-form');
    this.vaultPinInput = document.getElementById('vault-pin-input');
    this.vaultError = document.getElementById('vault-error');
    this.vaultCancelBtn = document.getElementById('vault-modal-cancel');

    this.downloadModal = document.getElementById('download-modal');
    this.downloadForm = document.getElementById('download-form');
    this.downloadUrlInput = document.getElementById('download-url-input');
    this.downloadNameInput = document.getElementById('download-name-input');
    this.downloadQueueList = document.getElementById('download-queue-list');
    this.downloadCountBadge = document.getElementById('download-badge');

    this.detailModal = document.getElementById('detail-modal');
    this.detailBackdrop = document.getElementById('detail-backdrop');
    this.detailTitle = document.getElementById('detail-title');
    this.detailYear = document.getElementById('detail-year');
    this.detailRes = document.getElementById('detail-res');
    this.detailCodec = document.getElementById('detail-codec');
    this.detailSize = document.getElementById('detail-size');
    this.detailPlot = document.getElementById('detail-plot');
    this.detailGenres = document.getElementById('detail-genres');
    this.detailTags = document.getElementById('detail-tags');
    this.detailGcsPath = document.getElementById('detail-gcs-path');
    this.detailPlayBtn = document.getElementById('detail-play-btn');
    this.detailRetagBtn = document.getElementById('detail-retag-btn');
    this.detailDeleteBtn = document.getElementById('detail-delete-btn');
  }

  initPlayer() {
    this.player = new KodimiPlayer();
  }

  initEvents() {
    // App Bar Scroll Shadow
    window.addEventListener('scroll', () => {
      if (window.scrollY > 40) {
        this.topAppBar.classList.add('scrolled');
      } else {
        this.topAppBar.classList.remove('scrolled');
      }
    });

    // Navigation Tabs
    this.navItems.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const filter = btn.dataset.filter;
        if (filter === 'vault') {
          if (!vaultState.isUnlocked()) {
            this.openVaultModal();
            return;
          }
          await this.loadVaultData();
        }

        this.navItems.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeFilter = filter;
        this.renderView();
      });
    });

    document.getElementById('brand-home').addEventListener('click', () => {
      this.navItems.forEach((b) => b.classList.remove('active'));
      document.querySelector('[data-filter="all"]').classList.add('active');
      this.activeFilter = 'all';
      this.searchInput.value = '';
      this.searchTerm = '';
      this.renderView();
    });

    // Search Input
    let debounceTimer = null;
    this.searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.searchTerm = e.target.value.trim().toLowerCase();
        this.renderView();
      }, 250);
    });

    // Ingest FAB & Modal
    this.fabIngest.addEventListener('click', () => this.openDownloadModal());
    document.getElementById('download-modal-close').addEventListener('click', () => {
      this.downloadModal.classList.remove('open');
    });

    this.downloadForm.addEventListener('submit', (e) => this.handleStartDownload(e));

    // Sync Bucket Button
    this.syncBtn.addEventListener('click', () => this.triggerBucketSync());

    // Logout Button
    this.logoutBtn.addEventListener('click', () => {
      authState.clearToken();
      vaultState.lock();
      this.loginModal.classList.add('open');
    });

    // Login Form
    this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));

    // Vault Form
    this.vaultForm.addEventListener('submit', (e) => this.handleVaultUnlock(e));
    this.vaultCancelBtn.addEventListener('click', () => {
      this.vaultModal.classList.remove('open');
    });

    // Detail Modal Close & Actions
    document.getElementById('detail-modal-close').addEventListener('click', () => {
      this.detailModal.classList.remove('open');
    });

    this.detailPlayBtn.addEventListener('click', () => {
      if (this.activeMedia) {
        this.detailModal.classList.remove('open');
        this.player.open(this.activeMedia, this.activeMedia.current_time || 0);
      }
    });

    this.detailRetagBtn.addEventListener('click', () => this.handleRetagMedia());
    this.detailDeleteBtn.addEventListener('click', () => this.handleDeleteMedia());

    // Delegate Click Events for Play & Info buttons on Cards & Carousels
    document.addEventListener('click', (e) => {
      const playBtn = e.target.closest('.quick-play-btn, #hero-play-btn');
      if (playBtn) {
        const id = playBtn.dataset.id;
        const item = this.findMediaById(id);
        if (item) this.player.open(item, item.current_time || 0);
        return;
      }

      const infoBtn = e.target.closest('.quick-info-btn, #hero-info-btn');
      if (infoBtn) {
        const id = infoBtn.dataset.id;
        const item = this.findMediaById(id);
        if (item) this.openDetailModal(item);
        return;
      }

      // Card click opens detail
      const card = e.target.closest('.media-card');
      if (card && !e.target.closest('.quick-play-btn, .quick-info-btn')) {
        const id = card.dataset.id;
        const item = this.findMediaById(id);
        if (item) this.openDetailModal(item);
        return;
      }

      // Carousel Scroll Buttons
      const navBtn = e.target.closest('.carousel-nav-btn');
      if (navBtn) {
        const targetId = navBtn.dataset.target;
        const track = document.getElementById(targetId);
        if (track) {
          const shift = track.clientWidth * 0.75;
          track.scrollBy({
            left: navBtn.classList.contains('left') ? -shift : shift,
            behavior: 'smooth',
          });
        }
      }

      // Download Cancel Button
      const cancelBtn = e.target.closest('.dl-cancel-btn');
      if (cancelBtn) {
        const dlId = cancelBtn.dataset.id;
        api.cancelDownload(dlId).then(() => this.loadDownloads());
      }
    });

    // Close Modals on Backdrop Click
    [this.downloadModal, this.detailModal, this.vaultModal].forEach((modal) => {
      if (!modal) return;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('open');
        }
      });
    });

    window.addEventListener('kodimi_auth_required', () => {
      this.loginModal.classList.add('open');
    });

    window.addEventListener('kodimi_player_closed', () => {
      this.loadData();
    });
  }

  async checkSessionAndLoad() {
    if (!authState.isAuthenticated()) {
      this.loginModal.classList.add('open');
      return;
    }

    try {
      await api.checkAuth();
      this.loginModal.classList.remove('open');
      this.loadData();
      this.setupDownloadStream();
    } catch {
      this.loginModal.classList.add('open');
    }
  }

  async handleLogin(e) {
    e.preventDefault();
    const pwd = this.loginPassword.value;
    if (!pwd) return;

    this.loginError.style.display = 'none';
    try {
      await api.login(pwd);
      this.loginModal.classList.remove('open');
      this.loginPassword.value = '';
      this.loadData();
      this.setupDownloadStream();
    } catch (err) {
      this.loginError.textContent = err.message || 'Incorrect password';
      this.loginError.style.display = 'block';
    }
  }

  openVaultModal() {
    this.vaultModal.classList.add('open');
    this.vaultPinInput.value = '';
    this.vaultError.style.display = 'none';
    this.vaultPinInput.focus();
  }

  async handleVaultUnlock(e) {
    e.preventDefault();
    const pin = this.vaultPinInput.value.trim();
    if (!pin) return;

    this.vaultError.style.display = 'none';
    try {
      await api.verifyPin(pin);
      vaultState.setPin(pin);
      this.vaultModal.classList.remove('open');

      this.navItems.forEach((b) => b.classList.remove('active'));
      if (this.navVaultBtn) this.navVaultBtn.classList.add('active');
      this.activeFilter = 'vault';

      await this.loadVaultData();
      this.renderView();
    } catch (err) {
      this.vaultError.textContent = err.message || 'Incorrect Vault PIN';
      this.vaultError.style.display = 'block';
      this.vaultPinInput.value = '';
      this.vaultPinInput.focus();
    }
  }

  async loadVaultData() {
    this.loadingIndicator.style.display = 'flex';
    try {
      const res = await api.getMedia({ adult: 'true', limit: 500 });
      this.privateItems = res.items || [];
    } catch (err) {
      console.error('Failed to load private media:', err);
      vaultState.lock();
    } finally {
      this.loadingIndicator.style.display = 'none';
    }
  }

  async loadData() {
    this.loadingIndicator.style.display = 'flex';
    try {
      const [mediaRes, cwRes] = await Promise.all([
        api.getMedia({ limit: 500 }),
        api.getContinueWatching().catch(() => ({ items: [] })),
      ]);

      this.mediaItems = mediaRes.items || [];
      this.continueWatching = cwRes.items || [];
      this.renderView();
    } catch (err) {
      console.error('Failed to load media catalog:', err);
    } finally {
      this.loadingIndicator.style.display = 'none';
    }
  }

  findMediaById(id) {
    return this.mediaItems.find((m) => m.id === id) ||
           this.continueWatching.find((m) => m.id === id) ||
           this.privateItems.find((m) => m.id === id);
  }

  renderView() {
    const isBrowsingHome = this.activeFilter === 'all' && !this.searchTerm;

    if (isBrowsingHome) {
      this.gridContainer.style.display = 'none';
      this.emptyState.style.display = 'none';

      const hero = this.mediaItems.find((m) => m.type === 'movie' && m.plot && m.plot.length > 20) || this.mediaItems[0];
      if (hero) {
        this.heroSection.style.display = 'flex';
        this.heroSection.innerHTML = renderHeroBanner(hero);
      } else {
        this.heroSection.style.display = 'none';
      }

      this.carouselsContainer.style.display = 'block';
      let html = '';

      if (this.continueWatching.length > 0) {
        html += renderCarousel('continue', 'Continue Watching', this.continueWatching);
      }

      html += renderCarousel('recent', 'Recently Added to GCS', this.mediaItems.slice(0, 18));

      const series = this.mediaItems.filter((m) => m.type === 'series');
      if (series.length > 0) {
        html += renderCarousel('series', 'TV Series & Shows', series);
      }

      const movies = this.mediaItems.filter((m) => m.type === 'movie');
      if (movies.length > 0) {
        html += renderCarousel('movies', 'Movies', movies);
      }

      const action = this.mediaItems.filter((m) => m.genres?.includes('Action') || m.genres?.includes('Thriller'));
      if (action.length > 0) {
        html += renderCarousel('action', 'Action & Thrillers', action);
      }

      const scifi = this.mediaItems.filter((m) => m.genres?.includes('Sci-Fi') || m.genres?.includes('Adventure'));
      if (scifi.length > 0) {
        html += renderCarousel('scifi', 'Sci-Fi & Fantasy', scifi);
      }

      this.carouselsContainer.innerHTML = html;
    } else {
      // Grid View
      this.heroSection.style.display = 'none';
      this.carouselsContainer.style.display = 'none';
      this.gridContainer.style.display = 'block';

      let filtered = this.mediaItems;

      if (this.activeFilter === 'vault') {
        filtered = this.privateItems;
        this.gridTitle.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="material-symbols-outlined" style="color: var(--md-sys-color-primary);">lock</span>
              <span>Private Vault (${filtered.length} titles)</span>
            </div>
            <button class="btn-tonal" id="lock-vault-btn" style="padding: 6px 16px; font-size: 13px;">
              <span class="material-symbols-outlined" style="font-size: 16px;">lock</span>
              <span>Lock Vault</span>
            </button>
          </div>
        `;

        setTimeout(() => {
          const lockBtn = document.getElementById('lock-vault-btn');
          if (lockBtn) {
            lockBtn.onclick = () => {
              vaultState.lock();
              this.privateItems = [];
              this.navItems.forEach((b) => b.classList.remove('active'));
              document.querySelector('[data-filter="all"]').classList.add('active');
              this.activeFilter = 'all';
              this.renderView();
            };
          }
        }, 0);
      } else if (this.activeFilter === 'movie') {
        filtered = filtered.filter((m) => m.type === 'movie');
        this.gridTitle.textContent = `Movies (${filtered.length})`;
      } else if (this.activeFilter === 'series') {
        filtered = filtered.filter((m) => m.type === 'series');
        this.gridTitle.textContent = `TV Shows (${filtered.length})`;
      } else if (this.activeFilter === 'continue') {
        filtered = this.continueWatching;
        this.gridTitle.textContent = `Continue Watching (${filtered.length})`;
      } else {
        this.gridTitle.textContent = `Search results for "${this.searchTerm}"`;
      }

      if (this.searchTerm) {
        const q = this.searchTerm;
        filtered = filtered.filter((m) => {
          const matchTitle = m.title?.toLowerCase().includes(q);
          const matchSeries = m.series_name?.toLowerCase().includes(q);
          const matchPlot = m.plot?.toLowerCase().includes(q);
          const matchGenres = m.genres?.some((g) => g.toLowerCase().includes(q));
          const matchTags = m.tags?.some((t) => t.toLowerCase().includes(q));
          return matchTitle || matchSeries || matchPlot || matchGenres || matchTags;
        });
        this.gridTitle.textContent = `Results for "${this.searchTerm}" (${filtered.length})`;
      }

      if (filtered.length === 0) {
        this.gridContent.innerHTML = '';
        this.emptyState.style.display = 'block';
      } else {
        this.emptyState.style.display = 'none';
        this.gridContent.innerHTML = filtered.map(renderMediaCard).join('');
      }
    }
  }

  openDetailModal(item) {
    this.activeMedia = item;
    const pin = vaultState.getPin();
    const pinParam = (item.is_adult && pin) ? `?pin=${encodeURIComponent(pin)}` : '';
    const thumbUrl = `/api/media/${item.id}/thumbnail${pinParam}`;
    let backdrop = item.backdrop_url || item.poster_url || thumbUrl;
    if (backdrop.includes('placehold.co') || item.is_adult) backdrop = thumbUrl;

    this.detailBackdrop.src = backdrop;
    this.detailBackdrop.onerror = () => {
      this.detailBackdrop.onerror = null;
      this.detailBackdrop.src = thumbUrl;
    };

    this.detailTitle.textContent = item.title;
    this.detailYear.textContent = item.year || '';
    this.detailRes.textContent = item.resolution ? item.resolution.toUpperCase() : '1080P';
    this.detailCodec.textContent = item.video_codec ? item.video_codec.toUpperCase() : '';
    this.detailSize.textContent = this.formatSize(item.size_bytes);
    this.detailPlot.textContent = item.plot || 'No synopsis available.';
    this.detailGcsPath.textContent = `gs://torrentz/${item.gcs_path}`;

    if (item.genres && item.genres.length > 0) {
      this.detailGenres.innerHTML = item.genres.map((g) => `<span class="chip">${g}</span>`).join('');
    } else {
      this.detailGenres.innerHTML = '';
    }

    if (item.tags && item.tags.length > 0) {
      this.detailTags.innerHTML = item.tags.map((t) => `<span class="chip chip-outline">#${t}</span>`).join('');
    } else {
      this.detailTags.innerHTML = '';
    }

    this.detailModal.classList.add('open');
  }

  async handleRetagMedia() {
    if (!this.activeMedia) return;

    this.detailRetagBtn.disabled = true;
    this.detailRetagBtn.innerHTML = `
      <span class="material-symbols-outlined" style="animation: spin 1s infinite linear;">refresh</span>
      <span>Gemini Thinking...</span>
    `;

    try {
      const res = await api.retagMedia(this.activeMedia.id);
      if (res.item) {
        this.activeMedia = res.item;
        this.openDetailModal(res.item);
        this.loadData();
      }
    } catch (err) {
      console.error('Failed to retag:', err);
    } finally {
      this.detailRetagBtn.disabled = false;
      this.detailRetagBtn.innerHTML = `
        <span class="material-symbols-outlined">auto_awesome</span>
        <span>Re-tag with AI</span>
      `;
    }
  }

  async handleDeleteMedia() {
    if (!this.activeMedia) return;
    if (confirm(`Remove "${this.activeMedia.title}" from catalog?`)) {
      try {
        await api.deleteMedia(this.activeMedia.id);
        this.detailModal.classList.remove('open');
        this.loadData();
      } catch (err) {
        console.error('Failed to delete:', err);
      }
    }
  }

  openDownloadModal() {
    this.downloadModal.classList.add('open');
    this.loadDownloads();
  }

  async loadDownloads() {
    try {
      const res = await api.getDownloads();
      const list = res.downloads || [];
      const activeCount = list.filter((d) => d.status === 'downloading').length;

      if (activeCount > 0) {
        this.downloadCountBadge.textContent = activeCount;
        this.downloadCountBadge.style.display = 'flex';
      } else {
        this.downloadCountBadge.style.display = 'none';
      }

      if (list.length === 0) {
        this.downloadQueueList.innerHTML = `
          <div style="text-align: center; color: var(--md-sys-color-outline); padding: 32px 0; font-size: 13px;">
            No active downloads. Paste a magnet or video link above.
          </div>
        `;
      } else {
        this.downloadQueueList.innerHTML = list.map(renderDownloadItem).join('');
      }
    } catch (err) {
      console.error('Failed to load downloads:', err);
    }
  }

  async handleStartDownload(e) {
    e.preventDefault();
    const url = this.downloadUrlInput.value.trim();
    const name = this.downloadNameInput.value.trim();
    if (!url) return;

    try {
      await api.startDownload(url, name);
      this.downloadUrlInput.value = '';
      this.downloadNameInput.value = '';
      this.loadDownloads();
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    }
  }

  setupDownloadStream() {
    if (this.eventSource) this.eventSource.close();
    const token = authState.getToken();
    if (!token) return;

    this.eventSource = new EventSource(`/api/downloads/events?token=${token}`);
    this.eventSource.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        if (update && update.id) {
          const itemEl = document.getElementById(`dl-${update.id}`);
          if (itemEl) {
            itemEl.outerHTML = renderDownloadItem(update);
          } else {
            this.loadDownloads();
          }

          if (update.status === 'completed') {
            this.loadData();
          }
        }
      } catch (_) {}
    };
  }

  async triggerBucketSync() {
    this.syncIcon.style.animation = 'spin 1s infinite linear';
    try {
      await api.syncBucket();
      const poll = setInterval(async () => {
        const status = await api.getSyncStatus();
        if (!status.inProgress) {
          clearInterval(poll);
          this.syncIcon.style.animation = 'none';
          this.loadData();
        }
      }, 3000);
    } catch (err) {
      this.syncIcon.style.animation = 'none';
      console.error('Bucket sync error:', err);
    }
  }

  formatSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown size';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${Math.round(mb)} MB`;
  }
}

// Global animation styles
const style = document.createElement('style');
style.textContent = `
  @keyframes spin { 100% { transform: rotate(360deg); } }
  .quality-dropdown { display: none; }
  .quality-dropdown.open { display: block; }
`;
document.head.appendChild(style);

window.addEventListener('DOMContentLoaded', () => {
  new KodimiApp();
});
