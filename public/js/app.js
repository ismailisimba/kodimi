/**
 * Kodimi Main Application Controller
 * Enhanced with Private Vault (PIN-protected), Material Design 3, & Multi-Resolution Player
 */
import { api, authState, vaultState, profileState } from './api.js?v=30';
import KodimiPlayer from './player.js?v=30';
import {
  renderHeroBanner,
  renderMediaCard,
  renderCatalogCard,
  renderCarousel,
  renderDownloadItem,
  renderSeriesCard,
  renderLiveChannelCard,
  renderSeriesModalContent,
  renderScheduleModalContent,
  renderProfileCard,
  renderAddProfileCard,
  buildRecentlyAddedFeed,
  collapseGroupedMedia,
  sortMoviesList,
  escapeHtml,
} from './components.js?v=30';

class KodimiApp {
  constructor() {
    this.mediaItems = [];
    this.continueWatching = [];
    this.privateItems = [];
    this.seriesList = [];
    this.liveChannels = [];
    this.liveCategories = [];
    this.liveCountries = [];
    this.activeLiveCategory = 'all';
    this.activeLiveCountry = 'all';
    this.liveSearchTerm = '';
    this.liveVerifiedOnly = true;
    this.liveOffset = 0;
    this.livePageLimit = 60;
    this.liveTotalCount = 0;
    this.currentSeriesData = null;
    this.activeSeason = 1;
    this.activeFilter = 'all';
    this.movieSortOrder = 'recent';
    this.searchTerm = '';
    this.activeMedia = null;
    this.featuredItem = null;
    this.player = null;
    this.eventSource = null;
    this.downloadModalPollInterval = null;
    this.profiles = [];
    this.isManagingProfiles = false;
    this.selectedProfileColor = '#e50914';

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
    this.gridSortBar = document.getElementById('grid-sort-bar');
    this.gridContent = document.getElementById('grid-content');
    this.emptyState = document.getElementById('empty-state');
    this.loadingIndicator = document.getElementById('loading-indicator');

    // Live TV Container Elements
    this.livetvContainer = document.getElementById('livetv-container');
    this.livetvCategoryChips = document.getElementById('livetv-category-chips');
    this.livetvCountryChips = document.getElementById('livetv-country-chips');
    this.livetvVerifiedToggle = document.getElementById('livetv-verified-toggle');
    this.livetvGrid = document.getElementById('livetv-grid');
    this.livetvLoadMoreContainer = document.getElementById('livetv-load-more-container');
    this.livetvLoadMoreBtn = document.getElementById('livetv-load-more-btn');
    this.livetvSearchInput = document.getElementById('livetv-search-input');
    this.livetvEmptyState = document.getElementById('livetv-empty-state');
    this.livetvTotalBadge = document.getElementById('livetv-total-badge');

    // Modals
    this.loginModal = document.getElementById('login-modal');
    this.loginForm = document.getElementById('login-form');
    this.loginPassword = document.getElementById('login-password');
    this.loginError = document.getElementById('login-error');

    this.switchProfileModal = document.getElementById('switch-profile-modal');
    this.switchProfileForm = document.getElementById('switch-profile-form');
    this.switchProfileCode = document.getElementById('switch-profile-code');
    this.switchProfileError = document.getElementById('switch-profile-error');
    this.switchProfileCancel = document.getElementById('switch-profile-cancel');

    this.changeCodeModal = document.getElementById('change-code-modal');
    this.changeCodeForm = document.getElementById('change-code-form');
    this.changeCodeCurrent = document.getElementById('change-code-current');
    this.changeCodeNew = document.getElementById('change-code-new');
    this.changeCodeConfirm = document.getElementById('change-code-confirm');
    this.changeCodeError = document.getElementById('change-code-error');
    this.changeCodeCancel = document.getElementById('change-code-cancel');

    this.vaultModal = document.getElementById('vault-modal');
    this.vaultForm = document.getElementById('vault-form');
    this.vaultPinInput = document.getElementById('vault-pin-input');
    this.vaultError = document.getElementById('vault-error');
    this.vaultCancelBtn = document.getElementById('vault-modal-cancel');

    this.downloadModal = document.getElementById('download-modal');
    this.downloadForm = document.getElementById('download-form');
    this.downloadUrlInput = document.getElementById('download-url-input');
    this.downloadNameInput = document.getElementById('download-name-input');
    this.downloadCategorySelect = document.getElementById('download-category-select');
    this.uploadCategorySelect = document.getElementById('upload-category-select');
    this.ingestPlatformBadge = document.getElementById('ingest-platform-badge');
    this.ingestPlaylistRow = document.getElementById('ingest-playlist-row');
    this.downloadPlaylistCheckbox = document.getElementById('download-playlist-checkbox');
    this.ingestPlaylistLabel = document.getElementById('ingest-playlist-label');
    this.downloadPlaylistLimit = document.getElementById('download-playlist-limit');
    this.downloadQueueList = document.getElementById('download-queue-list');
    this.downloadCountBadge = document.getElementById('download-badge');

    // Series Detail Modal
    this.seriesModal = document.getElementById('series-modal');
    this.seriesModalClose = document.getElementById('series-modal-close');
    this.seriesModalBody = document.getElementById('series-modal-body');

    // Schedule Guide Modal
    this.scheduleModal = document.getElementById('schedule-modal');
    this.scheduleModalClose = document.getElementById('schedule-modal-close');
    this.scheduleModalBody = document.getElementById('schedule-modal-body');

    // Ingest Modal Tabs & Direct Upload Elements
    this.tabBtnLink = document.getElementById('tab-btn-link');
    this.tabBtnUpload = document.getElementById('tab-btn-upload');
    this.tabContentLink = document.getElementById('tab-content-link');
    this.tabContentUpload = document.getElementById('tab-content-upload');
    this.uploadDropzone = document.getElementById('upload-dropzone');
    this.directFileInput = document.getElementById('direct-file-input');
    this.browseFilesBtn = document.getElementById('browse-files-btn');
    this.uploadProgressContainer = document.getElementById('upload-progress-container');
    this.uploadProgressList = document.getElementById('upload-progress-list');

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
    this.detailFixMatchBtn = document.getElementById('detail-fix-match-btn');
    this.detailFixMatchRow = document.getElementById('detail-fix-match-row');
    this.detailFixMatchInput = document.getElementById('detail-fix-match-input');
    this.detailFixMatchApply = document.getElementById('detail-fix-match-apply');
    this.detailSubtitleBtn = document.getElementById('detail-subtitle-btn');
    this.detailSubtitleBtnText = document.getElementById('detail-subtitle-btn-text');
    this.detailDeleteBtn = document.getElementById('detail-delete-btn');
    this.detailVaultBtn = document.getElementById('detail-vault-btn');
    this.detailVaultIcon = document.getElementById('detail-vault-icon');
    this.detailVaultText = document.getElementById('detail-vault-text');
    this.detailCategorySection = document.getElementById('detail-category-section');
    this.detailCategoryPills = document.getElementById('detail-category-pills');

    // Multi-Profile Elements
    this.profileSwitcherBtn = document.getElementById('profile-switcher-btn');
    this.navProfileAvatar = document.getElementById('nav-profile-avatar');
    this.navProfileName = document.getElementById('nav-profile-name');
    this.profileDropdown = document.getElementById('profile-dropdown');
    this.profileDropdownHeader = document.getElementById('profile-dropdown-header');
    this.dropdownSwitchProfileBtn = document.getElementById('dropdown-switch-profile-btn');
    this.dropdownChangeCodeBtn = document.getElementById('dropdown-change-code-btn');
    this.dropdownOwnerDivider = document.getElementById('dropdown-owner-divider');
    this.dropdownManageProfilesBtn = document.getElementById('dropdown-manage-profiles-btn');
    this.profileModal = document.getElementById('profile-modal');
    this.profileModalClose = document.getElementById('profile-modal-close');
    this.profilesGrid = document.getElementById('profiles-grid');
    this.manageProfilesBtn = document.getElementById('manage-profiles-btn');
    this.manageProfilesBtnText = document.getElementById('manage-profiles-btn-text');
    this.addProfileBtn = document.getElementById('add-profile-btn');
    this.profileEditModal = document.getElementById('profile-edit-modal');
    this.profileEditForm = document.getElementById('profile-edit-form');
    this.profileEditTitle = document.getElementById('profile-edit-title');
    this.profileEditId = document.getElementById('profile-edit-id');
    this.profileEditName = document.getElementById('profile-edit-name-input');
    this.profileEditPasscode = document.getElementById('profile-edit-passcode-input');
    this.profileEditPasscodeHint = document.getElementById('profile-edit-passcode-hint');
    this.profileEditAvatarPreview = document.getElementById('profile-edit-avatar-preview');
    this.profileColorSwatches = document.getElementById('profile-color-swatches');
    this.profileEditKidsToggle = document.getElementById('profile-edit-kids-toggle');
    this.profileEditError = document.getElementById('profile-edit-error');
    this.profileEditDeleteBtn = document.getElementById('profile-edit-delete-btn');
    this.profileEditCancelBtn = document.getElementById('profile-edit-cancel-btn');
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
          if (!profileState.isOwner()) {
            return;
          }
          if (!vaultState.isUnlocked()) {
            this.openVaultModal();
            return;
          }
          await this.loadVaultData();
        }

        if (filter === 'all') {
          this.selectNextFeaturedItem();
        }

        this.navItems.forEach((b) => b.classList.remove('active'));
        document.querySelectorAll(`.nav-item[data-filter="${filter}"]`).forEach((b) => b.classList.add('active'));
        this.activeFilter = filter;
        this.renderView();
      });
    });

    document.getElementById('brand-home').addEventListener('click', () => {
      this.navItems.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.nav-item[data-filter="all"]').forEach((b) => b.classList.add('active'));
      this.activeFilter = 'all';
      this.searchInput.value = '';
      this.searchTerm = '';
      this.selectNextFeaturedItem();
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

    // Ingest FAB & Modal (Owner-only)
    this.fabIngest.addEventListener('click', () => {
      if (!profileState.isOwner()) return;
      this.openDownloadModal();
    });
    document.getElementById('download-modal-close').addEventListener('click', () => {
      this.closeDownloadModal();
    });

    this.downloadForm.addEventListener('submit', (e) => this.handleStartDownload(e));

    if (this.downloadUrlInput) {
      this.downloadUrlInput.addEventListener('input', () => this.updateIngestPlatformHint());
    }

    // Ingest Modal Tabs
    if (this.tabBtnLink && this.tabBtnUpload) {
      this.tabBtnLink.addEventListener('click', () => {
        this.tabBtnLink.classList.add('active');
        this.tabBtnUpload.classList.remove('active');
        this.tabContentLink.style.display = 'block';
        this.tabContentUpload.style.display = 'none';
      });

      this.tabBtnUpload.addEventListener('click', () => {
        this.tabBtnUpload.classList.add('active');
        this.tabBtnLink.classList.remove('active');
        this.tabContentUpload.style.display = 'block';
        this.tabContentLink.style.display = 'none';
      });
    }

    // Direct Upload Dropzone & File Input
    if (this.uploadDropzone && this.directFileInput) {
      if (this.browseFilesBtn) {
        this.browseFilesBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.directFileInput.click();
        });
      }

      this.uploadDropzone.addEventListener('click', () => {
        this.directFileInput.click();
      });

      this.uploadDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.uploadDropzone.classList.add('dragover');
      });

      this.uploadDropzone.addEventListener('dragleave', () => {
        this.uploadDropzone.classList.remove('dragover');
      });

      this.uploadDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        this.uploadDropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.handleDirectFilesUpload(e.dataTransfer.files);
        }
      });

      this.directFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleDirectFilesUpload(e.target.files);
          this.directFileInput.value = '';
        }
      });
    }

    // Sync Bucket Button
    this.syncBtn.addEventListener('click', () => this.triggerBucketSync());

    // Logout Button
    this.logoutBtn.addEventListener('click', () => {
      this.closeDownloadStream();
      authState.clearToken();
      vaultState.lock();
      profileState.setActiveProfile(null);
      this.profiles = [];
      this.privateItems = [];
      this.applyRolePermissionsUI();
      this.loginModal.classList.add('open');
      if (this.loginPassword) this.loginPassword.focus();
    });

    // Login Form
    this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));

    // Switch Profile (Code-only) Form
    if (this.switchProfileForm) {
      this.switchProfileForm.addEventListener('submit', (e) => this.handleSwitchProfile(e));
    }
    if (this.switchProfileCancel) {
      this.switchProfileCancel.addEventListener('click', () => {
        if (this.switchProfileModal) this.switchProfileModal.classList.remove('open');
      });
    }

    // Change Own Login Code Form
    if (this.changeCodeForm) {
      this.changeCodeForm.addEventListener('submit', (e) => this.handleChangeCode(e));
    }
    if (this.changeCodeCancel) {
      this.changeCodeCancel.addEventListener('click', () => {
        if (this.changeCodeModal) this.changeCodeModal.classList.remove('open');
      });
    }

    // Detail Category Reclassification Pills (Owner-only)
    if (this.detailCategoryPills) {
      this.detailCategoryPills.addEventListener('click', async (e) => {
        const btn = e.target.closest('.detail-category-chip');
        if (!btn || !this.activeMedia || !profileState.isOwner()) return;
        const category = btn.dataset.category;
        if (!category) return;
        try {
          btn.disabled = true;
          const res = await api.updateMediaCategory(this.activeMedia.id, category);
          if (res && res.item) {
            this.activeMedia = res.item;
            this.openDetailModal(res.item);
            await this.loadData();
          }
        } catch (err) {
          alert(`Failed to update category: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    }

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
        const startTime = (this.activeMedia.current_time && this.activeMedia.current_time > 10) ? this.activeMedia.current_time : 0;
        this.player.open(this.activeMedia, startTime);
      }
    });

    this.detailRetagBtn.addEventListener('click', () => this.handleRetagMedia());
    if (this.detailFixMatchBtn && this.detailFixMatchRow) {
      this.detailFixMatchBtn.addEventListener('click', () => {
        const isHidden = this.detailFixMatchRow.style.display === 'none';
        this.detailFixMatchRow.style.display = isHidden ? 'flex' : 'none';
        if (isHidden && this.detailFixMatchInput) {
          this.detailFixMatchInput.focus();
          this.detailFixMatchInput.select();
        }
      });
    }
    if (this.detailFixMatchApply) {
      this.detailFixMatchApply.addEventListener('click', () => {
        const hint = this.detailFixMatchInput ? this.detailFixMatchInput.value.trim() : '';
        this.handleRetagMedia(hint);
      });
    }
    if (this.detailFixMatchInput) {
      this.detailFixMatchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleRetagMedia(this.detailFixMatchInput.value.trim());
        }
      });
    }
    this.detailDeleteBtn.addEventListener('click', () => this.handleDeleteMedia());

    if (this.detailSubtitleBtn) {
      const detailSubInput = document.createElement('input');
      detailSubInput.type = 'file';
      detailSubInput.accept = '.srt,.vtt,.ass,.ssa';
      detailSubInput.style.display = 'none';
      document.body.appendChild(detailSubInput);

      this.detailSubtitleBtn.addEventListener('click', () => {
        if (!this.activeMedia) return;
        detailSubInput.click();
      });

      detailSubInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        detailSubInput.value = '';
        if (!file || !this.activeMedia) return;

        try {
          this.detailSubtitleBtn.disabled = true;
          if (this.detailSubtitleBtnText) this.detailSubtitleBtnText.textContent = 'Uploading to GCS...';
          const res = await this.player.handleManualSubtitleFile(file, this.activeMedia);
          if (res && res.success) {
            if (this.detailSubtitleBtnText) this.detailSubtitleBtnText.textContent = '✓ Subtitle Saved!';
            setTimeout(() => {
              if (this.detailSubtitleBtnText) this.detailSubtitleBtnText.textContent = 'Add Subtitle';
            }, 2500);
          } else if (this.detailSubtitleBtnText) {
            this.detailSubtitleBtnText.textContent = 'Add Subtitle';
          }
        } finally {
          this.detailSubtitleBtn.disabled = false;
        }
      });
    }

    if (this.detailVaultBtn) {
      this.detailVaultBtn.addEventListener('click', async () => {
        if (!this.activeMedia) return;
        const targetAdult = !this.activeMedia.is_adult;
        try {
          this.detailVaultBtn.disabled = true;
          const res = await api.toggleVault(this.activeMedia.id, targetAdult);
          if (res && res.item) {
            this.activeMedia = res.item;
            this.openDetailModal(res.item);
          }
          await this.loadData();
          if (vaultState.isUnlocked()) {
            await this.loadVaultData();
          }
        } catch (err) {
          alert(`Failed to move item: ${err.message}`);
        } finally {
          this.detailVaultBtn.disabled = false;
        }
      });
    }

    // Series Modal Close
    if (this.seriesModalClose) {
      this.seriesModalClose.addEventListener('click', () => {
        this.seriesModal.classList.remove('open');
      });
    }

    // Schedule Modal Close
    if (this.scheduleModalClose) {
      this.scheduleModalClose.addEventListener('click', () => {
        this.scheduleModal.classList.remove('open');
      });
    }

    // Live TV Search Input, Verified Toggle & Load More Listeners
    if (this.livetvSearchInput) {
      let liveDebounce = null;
      this.livetvSearchInput.addEventListener('input', (e) => {
        clearTimeout(liveDebounce);
        liveDebounce = setTimeout(() => {
          this.liveSearchTerm = e.target.value.trim().toLowerCase();
          this.fetchLiveChannels(false);
        }, 300);
      });
    }

    if (this.livetvVerifiedToggle) {
      this.livetvVerifiedToggle.addEventListener('click', () => {
        this.liveVerifiedOnly = !this.liveVerifiedOnly;
        this.livetvVerifiedToggle.classList.toggle('active', this.liveVerifiedOnly);
        this.livetvVerifiedToggle.textContent = this.liveVerifiedOnly
          ? '✓ Verified Working Only'
          : 'All Channels (Unchecked Included)';
        this.fetchLiveChannels(false);
      });
    }

    if (this.livetvLoadMoreBtn) {
      this.livetvLoadMoreBtn.addEventListener('click', () => {
        this.fetchLiveChannels(true);
      });
    }

    // Delegate Click Events for Play & Info buttons on Cards, Carousels, Series & Live TV
    document.addEventListener('click', (e) => {
      // 1. Series Card / Browse / Info Button
      const seriesEl = e.target.closest('.series-card, .series-browse-btn, .series-info-btn');
      if (seriesEl) {
        const seriesName = seriesEl.dataset.seriesName;
        if (seriesName) this.openSeriesModal(seriesName);
        return;
      }

      // 2. Season Tab Switcher in Series Modal
      const seasonTab = e.target.closest('.season-tab-btn');
      if (seasonTab && this.currentSeriesData) {
        const seasonNum = parseInt(seasonTab.dataset.season, 10);
        this.activeSeason = seasonNum;
        this.renderSeriesModal(this.currentSeriesData, seasonNum);
        return;
      }

      // 3. Episode Play Button in Series Modal
      const epPlayBtn = e.target.closest('.episode-play-btn');
      if (epPlayBtn) {
        const epId = epPlayBtn.dataset.id;
        const ep = this.mediaItems.find((m) => m.id === epId) || this.privateItems.find((m) => m.id === epId);
        const startTime = parseFloat(epPlayBtn.dataset.time || (ep && ep.current_time) || 0);
        if (this.seriesModal) this.seriesModal.classList.remove('open');
        if (ep) {
          this.player.open(ep, startTime);
        } else {
          api.getMediaById(epId).then((res) => {
            const item = res?.item || res;
            if (item) this.player.open(item, startTime);
          }).catch(() => {});
        }
        return;
      }

      // 3b. Episode Info / Synopsis Fix Button in Series Modal
      const epInfoBtn = e.target.closest('.episode-info-btn');
      if (epInfoBtn) {
        const epId = epInfoBtn.dataset.id;
        const ep = this.findMediaById(epId);
        if (ep) {
          this.openDetailModal(ep);
        } else if (epId) {
          api.getMediaById(epId).then((res) => {
            const item = res?.item || res;
            if (item) this.openDetailModal(item);
          }).catch(() => {});
        }
        return;
      }

      // 3c. Series Fix Match Toggle & Series Re-tag Buttons
      const seriesFixToggle = e.target.closest('#series-fix-match-toggle-btn');
      if (seriesFixToggle) {
        const row = document.getElementById('series-fix-match-row');
        const input = document.getElementById('series-fix-match-input');
        if (row) {
          const isHidden = row.style.display === 'none';
          row.style.display = isHidden ? 'flex' : 'none';
          if (isHidden && input) input.focus();
        }
        return;
      }

      const seriesRetagBtn = e.target.closest('#series-retag-btn, #series-fix-match-apply-btn');
      if (seriesRetagBtn) {
        const seriesName = seriesRetagBtn.dataset.seriesName;
        const input = document.getElementById('series-fix-match-input');
        const hint = seriesRetagBtn.id === 'series-fix-match-apply-btn' && input ? input.value.trim() : '';
        if (seriesName) {
          this.handleRetagSeries(seriesName, hint);
        }
        return;
      }

      // 3d. Movies Sort Chips
      const movieSortChip = e.target.closest('.movie-sort-chip');
      if (movieSortChip) {
        const nextSort = movieSortChip.dataset.movieSort || 'recent';
        if (this.movieSortOrder !== nextSort) {
          this.movieSortOrder = nextSort;
          this.renderView();
        }
        return;
      }

      // 4. Live TV Play Button
      const livePlayBtn = e.target.closest('.live-play-btn');
      if (livePlayBtn) {
        const streamUrl = livePlayBtn.dataset.streamUrl;
        const name = livePlayBtn.dataset.name;
        const chId = livePlayBtn.dataset.channelId;
        const ch = this.liveChannels.find((c) => c.id === chId) || { id: chId, name, streamUrl };
        if (this.scheduleModal) this.scheduleModal.classList.remove('open');
        this.player.openLive(ch);
        return;
      }

      // 5. Live TV Schedule Guide Button
      const liveScheduleBtn = e.target.closest('.live-schedule-btn');
      if (liveScheduleBtn) {
        const chId = liveScheduleBtn.dataset.channelId;
        this.openScheduleModal(chId);
        return;
      }

      // 6. Live TV Category & Country Filter Chips
      const catChip = e.target.closest('.live-cat-chip');
      if (catChip) {
        this.activeLiveCategory = catChip.dataset.category;
        this.fetchLiveChannels();
        return;
      }

      const countryChip = e.target.closest('.live-country-chip');
      if (countryChip) {
        this.activeLiveCountry = countryChip.dataset.country;
        this.fetchLiveChannels();
        return;
      }

      // 7. Regular Media Play & Info Buttons
      const playBtn = e.target.closest('.quick-play-btn, #hero-play-btn');
      if (playBtn) {
        if (playBtn.id === 'hero-play-btn' && playBtn.dataset.seriesName) {
          this.openSeriesModal(playBtn.dataset.seriesName);
          return;
        }
        const id = playBtn.dataset.id;
        const item = this.findMediaById(id);
        const startTime = parseFloat(playBtn.dataset.time || (item && item.current_time) || 0);
        if (item) this.player.open(item, startTime);
        return;
      }

      const infoBtn = e.target.closest('.quick-info-btn, #hero-info-btn');
      if (infoBtn) {
        if (infoBtn.id === 'hero-info-btn' && infoBtn.dataset.seriesName) {
          this.openSeriesModal(infoBtn.dataset.seriesName);
          return;
        }
        const id = infoBtn.dataset.id;
        const item = this.findMediaById(id);
        if (item) this.openDetailModal(item);
        return;
      }

      const watchedBtn = e.target.closest('.quick-watched-btn');
      if (watchedBtn) {
        e.stopPropagation();
        const id = watchedBtn.dataset.id;
        if (id) {
          this.continueWatching = this.continueWatching.filter((m) => m.id !== id);
          this.renderView();
          api.dismissContinueWatching(id).then(() => this.loadData()).catch(() => this.loadData());
        }
        return;
      }

      // 8. Regular Media Card click opens detail
      const card = e.target.closest('.media-card');
      if (card && !e.target.closest('.quick-play-btn, .quick-info-btn, .quick-watched-btn, .series-card')) {
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

      // Download Actions (Pause, Resume, Delete/Cancel)
      const pauseBtn = e.target.closest('.dl-pause-btn');
      if (pauseBtn) {
        const dlId = pauseBtn.dataset.id;
        api.pauseDownload(dlId).then(() => this.loadDownloads());
        return;
      }

      const resumeBtn = e.target.closest('.dl-resume-btn');
      if (resumeBtn) {
        const dlId = resumeBtn.dataset.id;
        api.resumeDownload(dlId).then(() => this.loadDownloads());
        return;
      }

      const deleteBtn = e.target.closest('.dl-delete-btn, .dl-cancel-btn');
      if (deleteBtn) {
        const dlId = deleteBtn.dataset.id;
        const itemEl = document.getElementById(`dl-${dlId}`);
        if (itemEl) itemEl.remove();
        api.deleteDownload(dlId).then(() => this.loadDownloads());
        return;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'series-fix-match-input') {
        e.preventDefault();
        const applyBtn = document.getElementById('series-fix-match-apply-btn');
        const seriesName = applyBtn ? applyBtn.dataset.seriesName : '';
        if (seriesName) {
          this.handleRetagSeries(seriesName, e.target.value.trim());
        }
      }
    });

    // Close Modals on Backdrop Click
    [
      this.downloadModal,
      this.detailModal,
      this.vaultModal,
      this.seriesModal,
      this.scheduleModal,
      this.profileModal,
      this.profileEditModal,
      this.switchProfileModal,
      this.changeCodeModal,
    ].forEach((modal) => {
      if (!modal) return;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          if (modal === this.downloadModal) {
            this.closeDownloadModal();
          } else {
            modal.classList.remove('open');
          }
        }
      });
    });

    this.initProfileEvents();

    window.addEventListener('kodimi_auth_required', () => {
      this.closeDownloadStream();
      this.applyRolePermissionsUI();
      this.loginModal.classList.add('open');
      if (this.loginPassword) this.loginPassword.focus();
    });

    window.addEventListener('kodimi_player_closed', () => {
      this.loadData();
    });
  }

  initProfileEvents() {
    if (this.profileSwitcherBtn) {
      this.profileSwitcherBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = this.profileDropdown.style.display === 'block';
        this.profileDropdown.style.display = isOpen ? 'none' : 'block';
      });
    }

    document.addEventListener('click', (e) => {
      if (this.profileDropdown && !this.profileDropdown.contains(e.target) && e.target !== this.profileSwitcherBtn) {
        this.profileDropdown.style.display = 'none';
      }
    });

    if (this.dropdownSwitchProfileBtn) {
      this.dropdownSwitchProfileBtn.addEventListener('click', () => {
        this.profileDropdown.style.display = 'none';
        if (this.switchProfileModal) {
          this.switchProfileCode.value = '';
          this.switchProfileError.style.display = 'none';
          this.switchProfileModal.classList.add('open');
          this.switchProfileCode.focus();
        }
      });
    }

    if (this.dropdownChangeCodeBtn) {
      this.dropdownChangeCodeBtn.addEventListener('click', () => {
        this.profileDropdown.style.display = 'none';
        if (this.changeCodeModal) {
          this.changeCodeCurrent.value = '';
          this.changeCodeNew.value = '';
          this.changeCodeConfirm.value = '';
          this.changeCodeError.style.display = 'none';
          this.changeCodeModal.classList.add('open');
          this.changeCodeCurrent.focus();
        }
      });
    }

    if (this.dropdownManageProfilesBtn) {
      this.dropdownManageProfilesBtn.addEventListener('click', async () => {
        this.profileDropdown.style.display = 'none';
        if (!profileState.isOwner()) return;
        await this.loadProfiles();
        this.openProfileModal(true);
      });
    }

    if (this.profileModalClose) {
      this.profileModalClose.addEventListener('click', () => this.closeProfileModal());
    }

    if (this.manageProfilesBtn) {
      this.manageProfilesBtn.addEventListener('click', () => {
        this.closeProfileModal();
      });
    }

    if (this.addProfileBtn) {
      this.addProfileBtn.addEventListener('click', () => {
        if (!profileState.isOwner()) return;
        this.openProfileEditModal(null);
      });
    }

    if (this.profileEditCancelBtn) {
      this.profileEditCancelBtn.addEventListener('click', () => {
        this.closeProfileEditModal();
      });
    }

    if (this.profileColorSwatches) {
      this.profileColorSwatches.addEventListener('click', (e) => {
        const swatch = e.target.closest('.color-swatch');
        if (!swatch) return;
        this.profileColorSwatches.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        this.selectedProfileColor = swatch.dataset.color || '#e50914';
        if (this.profileEditAvatarPreview) {
          this.profileEditAvatarPreview.style.backgroundColor = this.selectedProfileColor;
        }
      });
    }

    if (this.profileEditForm) {
      this.profileEditForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!profileState.isOwner()) return;
        const id = this.profileEditId.value;
        const name = this.profileEditName.value.trim();
        const color = this.selectedProfileColor;
        const isKids = this.profileEditKidsToggle ? this.profileEditKidsToggle.checked : false;
        const passcode = this.profileEditPasscode ? this.profileEditPasscode.value.trim() : '';

        this.profileEditError.style.display = 'none';
        if (!id && passcode.length < 4) {
          this.profileEditError.textContent = 'A unique login code (at least 4 characters) is required for new profiles.';
          this.profileEditError.style.display = 'block';
          return;
        }
        if (passcode && passcode.length < 4) {
          this.profileEditError.textContent = 'Login code must be at least 4 characters.';
          this.profileEditError.style.display = 'block';
          return;
        }

        try {
          if (id) {
            const payload = { name, color, is_kids: isKids };
            if (passcode) payload.passcode = passcode;
            await api.updateProfile(id, payload);
          } else {
            await api.createProfile({ name, color, is_kids: isKids, passcode });
          }
          this.closeProfileEditModal();
          await this.loadProfiles();
          this.renderProfileSelector();

          const current = profileState.getActiveProfile();
          if (current && current.id === id) {
            const updated = this.profiles.find((p) => p.id === id);
            if (updated) {
              profileState.setActiveProfile(updated);
              this.applyRolePermissionsUI();
            }
          }
        } catch (err) {
          this.profileEditError.textContent = err.message || 'Failed to save profile';
          this.profileEditError.style.display = 'block';
        }
      });
    }

    if (this.profileEditDeleteBtn) {
      this.profileEditDeleteBtn.addEventListener('click', async () => {
        const id = this.profileEditId.value;
        if (!id || !profileState.isOwner()) return;
        if (!confirm('Are you sure you want to delete this profile? Playback history and watchlist for this profile will be permanently removed.')) {
          return;
        }

        try {
          await api.deleteProfile(id);
          this.closeProfileEditModal();
          await this.loadProfiles();
          this.renderProfileSelector();
        } catch (err) {
          this.profileEditError.textContent = err.message || 'Cannot delete profile';
          this.profileEditError.style.display = 'block';
        }
      });
    }
  }

  async loadProfiles() {
    if (!profileState.isOwner()) {
      this.profiles = [];
      return;
    }
    try {
      const res = await api.getProfiles();
      this.profiles = res.profiles || [];
    } catch (err) {
      console.warn('[Profiles] Could not load profiles:', err);
      this.profiles = [];
    }
  }

  applyRolePermissionsUI() {
    const active = profileState.getActiveProfile();
    const isOwner = profileState.isOwner();

    if (active) {
      if (this.navProfileName) this.navProfileName.textContent = active.name;
      if (this.navProfileAvatar) {
        this.navProfileAvatar.style.backgroundColor = active.color || '#e50914';
        const icon = active.avatar || 'account_circle';
        this.navProfileAvatar.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">${icon}</span>`;
      }
      if (this.profileDropdownHeader) {
        const roleLabel = isOwner ? 'Owner • Admin' : active.is_kids ? 'Kids Profile' : 'Member';
        this.profileDropdownHeader.textContent = `${active.name} (${roleLabel})`;
      }
    } else {
      if (this.navProfileName) this.navProfileName.textContent = 'Sign In';
      if (this.profileDropdownHeader) this.profileDropdownHeader.textContent = 'Not Signed In';
    }

    // Strictly hide Owner-only controls from non-owner profiles
    if (this.fabIngest) this.fabIngest.style.display = isOwner ? 'flex' : 'none';
    if (this.syncBtn) this.syncBtn.style.display = isOwner ? 'flex' : 'none';
    if (this.dropdownManageProfilesBtn) this.dropdownManageProfilesBtn.style.display = isOwner ? 'flex' : 'none';
    if (this.dropdownOwnerDivider) this.dropdownOwnerDivider.style.display = isOwner ? 'block' : 'none';

    const vaultBtns = [this.navVaultBtn, document.getElementById('mobile-nav-vault-btn')];
    vaultBtns.forEach((btn) => {
      if (btn) btn.style.display = isOwner ? 'flex' : 'none';
    });

    if (!isOwner && this.activeFilter === 'vault') {
      vaultState.lock();
      this.privateItems = [];
      this.activeFilter = 'all';
      this.navItems.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.nav-item[data-filter="all"]').forEach((b) => b.classList.add('active'));
    }
  }

  renderProfileSelector() {
    if (!this.profilesGrid || !profileState.isOwner()) return;
    const active = profileState.getActiveProfile();
    let html = this.profiles
      .map((p) => renderProfileCard(p, true))
      .join('');
    html += renderAddProfileCard();

    this.profilesGrid.innerHTML = html;
    this.profilesGrid.classList.add('managing-profiles');

    this.profilesGrid.querySelectorAll('.profile-card').forEach((card) => {
      if (card.id === 'profile-card-add') {
        card.addEventListener('click', () => this.openProfileEditModal(null));
        return;
      }
      const id = card.dataset.profileId;
      const profile = this.profiles.find((p) => p.id === id);
      if (!profile) return;

      if (active && active.id === id) {
        card.classList.add('active');
      }

      card.addEventListener('click', () => {
        this.openProfileEditModal(profile);
      });
    });
  }

  openProfileModal() {
    if (!profileState.isOwner()) return;
    this.isManagingProfiles = true;
    this.renderProfileSelector();
    if (this.profileModal) this.profileModal.classList.add('open');
  }

  closeProfileModal() {
    if (this.profileModal) this.profileModal.classList.remove('open');
    this.isManagingProfiles = false;
  }

  openProfileEditModal(profile = null) {
    if (!this.profileEditModal || !profileState.isOwner()) return;
    this.profileEditError.style.display = 'none';

    if (profile) {
      this.profileEditTitle.textContent = `Edit Profile: ${profile.name}`;
      this.profileEditId.value = profile.id;
      this.profileEditName.value = profile.name;
      this.selectedProfileColor = profile.color || '#e50914';
      if (this.profileEditPasscode) {
        this.profileEditPasscode.value = '';
        this.profileEditPasscode.required = false;
        this.profileEditPasscode.placeholder = profile.has_passcode
          ? 'Leave blank to keep current login code'
          : 'Set a unique login code to unlock this profile';
      }
      if (this.profileEditPasscodeHint) {
        this.profileEditPasscodeHint.textContent = profile.has_passcode
          ? '(optional — enter to change)'
          : '(not set yet — required for this profile to sign in)';
      }
      if (this.profileEditKidsToggle) {
        this.profileEditKidsToggle.checked = Boolean(profile.is_kids);
        this.profileEditKidsToggle.disabled = profile.id === 'default' || profile.role === 'owner';
      }
      if (this.profileEditDeleteBtn) {
        this.profileEditDeleteBtn.style.display =
          profile.id !== 'default' && profile.role !== 'owner' && this.profiles.length > 1 ? 'flex' : 'none';
      }
    } else {
      this.profileEditTitle.textContent = 'Add Profile';
      this.profileEditId.value = '';
      this.profileEditName.value = '';
      this.selectedProfileColor = '#007aff';
      if (this.profileEditPasscode) {
        this.profileEditPasscode.value = '';
        this.profileEditPasscode.required = true;
        this.profileEditPasscode.placeholder = 'Enter unique login code (min 4 chars)';
      }
      if (this.profileEditPasscodeHint) {
        this.profileEditPasscodeHint.textContent = '(required, must be unique)';
      }
      if (this.profileEditKidsToggle) {
        this.profileEditKidsToggle.checked = false;
        this.profileEditKidsToggle.disabled = false;
      }
      if (this.profileEditDeleteBtn) {
        this.profileEditDeleteBtn.style.display = 'none';
      }
    }

    if (this.profileEditAvatarPreview) {
      this.profileEditAvatarPreview.style.backgroundColor = this.selectedProfileColor;
    }

    if (this.profileColorSwatches) {
      this.profileColorSwatches.querySelectorAll('.color-swatch').forEach((s) => {
        s.classList.toggle('active', s.dataset.color === this.selectedProfileColor);
      });
    }

    this.profileEditModal.classList.add('open');
    if (this.profileEditName) this.profileEditName.focus();
  }

  closeProfileEditModal() {
    if (this.profileEditModal) this.profileEditModal.classList.remove('open');
  }

  async checkSessionAndLoad() {
    if (!authState.isAuthenticated()) {
      this.applyRolePermissionsUI();
      this.loginModal.classList.add('open');
      if (this.loginPassword) this.loginPassword.focus();
      return;
    }

    try {
      await api.checkAuth();
      this.loginModal.classList.remove('open');
      this.applyRolePermissionsUI();

      this.loadData();
      if (profileState.isOwner()) {
        this.loadProfiles();
        this.loadDownloads();
      }
    } catch {
      this.applyRolePermissionsUI();
      this.loginModal.classList.add('open');
    }
  }

  async handleLogin(e) {
    e.preventDefault();
    const code = this.loginPassword.value.trim();
    if (!code) return;

    this.loginError.style.display = 'none';
    try {
      await api.login(code);
      this.loginModal.classList.remove('open');
      this.loginPassword.value = '';

      this.applyRolePermissionsUI();
      this.loadData();
      if (profileState.isOwner()) {
        this.loadProfiles();
        this.loadDownloads();
      } else {
        this.closeDownloadStream();
      }
    } catch (err) {
      this.loginError.textContent = err.message || 'Invalid login code';
      this.loginError.style.display = 'block';
    }
  }

  async handleSwitchProfile(e) {
    e.preventDefault();
    const code = this.switchProfileCode.value.trim();
    if (!code) return;

    this.switchProfileError.style.display = 'none';
    try {
      this.closeDownloadStream();
      await api.login(code);
      this.switchProfileCode.value = '';
      if (this.switchProfileModal) this.switchProfileModal.classList.remove('open');

      this.privateItems = [];
      this.applyRolePermissionsUI();
      this.loadData();
      if (profileState.isOwner()) {
        this.loadProfiles();
        this.loadDownloads();
      }
    } catch (err) {
      this.switchProfileError.textContent = err.message || 'Invalid login code';
      this.switchProfileError.style.display = 'block';
    }
  }

  async handleChangeCode(e) {
    e.preventDefault();
    const currentCode = this.changeCodeCurrent.value.trim();
    const newCode = this.changeCodeNew.value.trim();
    const confirmCode = this.changeCodeConfirm.value.trim();

    this.changeCodeError.style.display = 'none';
    if (newCode.length < 4) {
      this.changeCodeError.textContent = 'New login code must be at least 4 characters.';
      this.changeCodeError.style.display = 'block';
      return;
    }
    if (newCode !== confirmCode) {
      this.changeCodeError.textContent = 'New login codes do not match.';
      this.changeCodeError.style.display = 'block';
      return;
    }

    try {
      await api.changeCode(currentCode, newCode);
      if (this.changeCodeModal) this.changeCodeModal.classList.remove('open');
      alert('Your personal login code has been updated!');
    } catch (err) {
      this.changeCodeError.textContent = err.message || 'Failed to update login code';
      this.changeCodeError.style.display = 'block';
    }
  }

  openVaultModal() {
    if (!profileState.isOwner()) return;
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
      document.querySelectorAll('.nav-item[data-filter="vault"]').forEach((b) => b.classList.add('active'));
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

  isPrivateOrAdultItem(item) {
    if (!item) return true;
    if (item.is_adult) return true;
    if (Array.isArray(item.genres) && item.genres.some((g) => /^(adult|erotic|18\+|nsfw|private|xxx)$/i.test(String(g).trim()))) {
      return true;
    }
    if (Array.isArray(item.tags) && item.tags.some((t) => /^(private|18\+|adult|nsfw|xxx)$/i.test(String(t).trim()))) {
      return true;
    }
    if (item.plot === 'Private Media content.') return true;

    const fullText = `${item.title || ''} ${item.series_name || ''} ${item.filename || ''} ${item.gcs_path || ''}`;
    const fileAndSeriesText = `${item.series_name || ''} ${item.filename || ''} ${item.gcs_path || ''} ${item.type !== 'series' ? (item.title || '') : ''}`;

    if (/\b(facefuck|anal|assaholic|porn|porno|xxx|nsfw|creampie|blowjob|handjob|deepthroat|pussy|cock|dickdrainer|slut|sluts|slutty|whore|milf|milfs|hentai|threesome|gangbang|orgy|dildo|masturbat|cumshot|squirt|bdsm|femdom|bondage|fetish|erotic|hardcore|stepmom|stepsis|stepsister|brazzers|bangbros|naughtyamerica|realitykings|mofos|evilangel|blacked|tushy|vixen|deeper|slayed|sextury|21sextury|dorcel|puretaboo|swallowed|realwifestories|fakehostel|fakehub|diabolic|analcollege|woodman|teenslikeitbig|teamskeet|digitalplayground|wickedpictures|onlyfans|manyvids|chaturbate|siterip|ahasss)\b/i.test(fullText)) {
      return true;
    }
    if (/\b(fuck|fucks|fucked|fucking|dick)\b/i.test(fileAndSeriesText)) {
      return true;
    }
    if (/(21 sextury|pure pleasures|pure taboo|naughty america|reality kings|evil angel|fake hostel|fake taxi|anal college|dick drainers|reality junkies|split scenes)/i.test(fullText)) {
      return true;
    }
    const baseName = String(item.filename || item.gcs_path || '').replace(/\.[^/.]+$/, '').trim();
    if (/^(0*\d{1,4}|testvid\d*|vid_?\d+|clip_?\d+|private_?.*)$/i.test(baseName)) {
      return true;
    }
    return false;
  }

  isFeaturedSafe(item) {
    if (this.isPrivateOrAdultItem(item)) return false;
    if (!item.plot || item.plot.length <= 25) return false;
    if (item.plot === 'Private Media content.' || item.plot.includes('newly indexed media file')) return false;

    const titleText = `${item.title || ''} ${item.series_name || ''}`;
    if (/\b(fuck|shit|slut|anal|ass|porn|xxx|scene\s+\d+)\b/i.test(titleText)) return false;

    const MAINSTREAM_GENRES = new Set([
      'action', 'adventure', 'animation', 'biography', 'comedy', 'crime',
      'documentary', 'drama', 'family', 'fantasy', 'history', 'horror',
      'music', 'musical', 'mystery', 'romance', 'sci-fi', 'science fiction',
      'sport', 'thriller', 'war', 'western', 'psychological thriller'
    ]);
    const hasMainstreamGenre = Array.isArray(item.genres) && item.genres.some((g) => MAINSTREAM_GENRES.has(String(g).trim().toLowerCase()));
    if (!hasMainstreamGenre) return false;

    if (item.type === 'movie' && (!item.year || item.year < 1950 || item.year > 2030)) {
      return false;
    }
    return true;
  }

  async loadData() {
    this.loadingIndicator.style.display = 'flex';
    try {
      const [mediaRes, cwRes, seriesRes] = await Promise.all([
        api.getMedia({ limit: 500 }),
        api.getContinueWatching().catch(() => ({ items: [] })),
        api.getSeries().catch(() => ({ items: [] })),
      ]);

      const allMedia = mediaRes.items || [];
      const allCw = cwRes.items || [];
      const allSeries = seriesRes.items || [];

      // Strictly filter out private/adult content from public views at all times
      // (Vault items are loaded exclusively into this.privateItems when viewing the Vault tab)
      this.mediaItems = allMedia.filter((m) => !this.isPrivateOrAdultItem(m));
      this.continueWatching = allCw.filter((m) => !this.isPrivateOrAdultItem(m));
      this.seriesList = allSeries.filter((s) => !this.isPrivateOrAdultItem(s));

      this.selectNextFeaturedItem();
      this.renderView();
    } catch (err) {
      console.error('Failed to load media catalog:', err);
    } finally {
      this.loadingIndicator.style.display = 'none';
    }
  }

  getEligibleFeaturedItems() {
    // 1. Candidate movies that pass strict Featured safety, genre, year, and plot checks
    const candidateMovies = (this.mediaItems || []).filter(
      (m) => m.type === 'movie' && this.isFeaturedSafe(m)
    );

    // 2. Candidate series that pass strict Featured safety, genre, and plot checks
    const candidateSeries = (this.seriesList || []).filter(
      (s) => this.isFeaturedSafe(s)
    );

    let candidates = [...candidateMovies, ...candidateSeries];

    // Fallback if no rich items found (still strictly excluding any private/adult items)
    if (candidates.length === 0) {
      candidates = (this.mediaItems || []).filter((m) => !this.isPrivateOrAdultItem(m));
    }

    return candidates;
  }

  selectNextFeaturedItem() {
    const candidates = this.getEligibleFeaturedItems();
    if (!candidates || candidates.length === 0) {
      this.featuredItem = null;
      return null;
    }

    if (candidates.length === 1) {
      this.featuredItem = candidates[0];
      return this.featuredItem;
    }

    let lastId = null;
    try {
      lastId = sessionStorage.getItem('kodimi_last_featured_id');
    } catch (_) {}

    const currentId = this.featuredItem?.id || lastId;
    // Exclude the last shown item so it is GUARANTEED to change on every reload or visit
    const pool = candidates.filter((c) => c.id !== currentId);
    const selectionPool = pool.length > 0 ? pool : candidates;

    const randomIndex = Math.floor(Math.random() * selectionPool.length);
    const selected = selectionPool[randomIndex];
    this.featuredItem = selected;

    try {
      sessionStorage.setItem('kodimi_last_featured_id', selected.id);
    } catch (_) {}

    return selected;
  }

  findMediaById(id) {
    const cw = this.continueWatching.find((m) => m.id === id);
    const media = this.mediaItems.find((m) => m.id === id) ||
           this.privateItems.find((m) => m.id === id) ||
           (this.seriesList && this.seriesList.find((s) => s.id === id));
    if (cw) {
      return { ...(media || {}), ...cw, current_time: cw.current_time };
    }
    return media || null;
  }

  isDocumentaryItem(item) {
    if (!item) return false;
    if (item.type === 'documentary') return true;
    if (Array.isArray(item.genres) && item.genres.some((g) => String(g).toLowerCase() === 'documentary')) return true;
    if (Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase() === 'documentary')) return true;
    return false;
  }

  isOthersItem(item) {
    if (!item) return false;
    if (item.type === 'others') return true;
    if (Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase() === 'others')) return true;
    return false;
  }

  detectClientSocialPlatform(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || '').trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const h = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'YouTube';
      if (h === 'instagram.com' || h.endsWith('.instagram.com') || h === 'instagr.am') return 'Instagram';
      if (h === 'twitter.com' || h.endsWith('.twitter.com') || h === 'x.com' || h.endsWith('.x.com')) return 'Twitter / X';
      if (h === 'reddit.com' || h.endsWith('.reddit.com') || h === 'v.redd.it' || h === 'redd.it') return 'Reddit';
      if (h === 'linkedin.com' || h.endsWith('.linkedin.com') || h === 'lnkd.in') return 'LinkedIn';
      if (h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.watch' || h === 'fb.com') return 'Facebook';
      return null;
    } catch {
      return null;
    }
  }

  detectClientPlaylistIntent(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || '').trim());
      const p = parsed.pathname.toLowerCase();
      const listParam = parsed.searchParams.get('list');
      const isAutoMix = Boolean(listParam && /^RD/i.test(listParam));
      const isExplicit =
        p === '/playlist' ||
        p.startsWith('/playlist/') ||
        p.startsWith('/course') ||
        p.startsWith('/podcasts') ||
        p.includes('/watch/playlist') ||
        p.includes('/playlists') ||
        p.includes('/media/set') ||
        p.includes('/stories/highlights/') ||
        p.includes('/collection/') ||
        p.includes('/collections/') ||
        /\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|shorts|streams|playlists)\/?$/i.test(p);
      return {
        isExplicit,
        hasListParam: Boolean(listParam),
        isAutoMix,
      };
    } catch {
      return { isExplicit: false, hasListParam: false, isAutoMix: false };
    }
  }

  updateIngestPlatformHint() {
    if (!this.downloadUrlInput || !this.ingestPlatformBadge) return;
    const rawVal = this.downloadUrlInput.value;
    const platform = this.detectClientSocialPlatform(rawVal);
    if (platform) {
      const intent = this.detectClientPlaylistIntent(rawVal);
      this.ingestPlatformBadge.textContent = intent.isExplicit
        ? `${platform} playlist detected`
        : `${platform} link detected`;
      this.ingestPlatformBadge.style.display = 'inline-flex';
      if (this.downloadCategorySelect && !this.downloadCategorySelect.value) {
        this.downloadCategorySelect.value = 'others';
      }
      if (this.ingestPlaylistRow) {
        this.ingestPlaylistRow.style.display = 'flex';
      }
      if (this.downloadPlaylistCheckbox) {
        if (intent.isExplicit) {
          this.downloadPlaylistCheckbox.checked = true;
        } else if (intent.hasListParam && !intent.isAutoMix) {
          this.downloadPlaylistCheckbox.checked = false;
        }
      }
      if (this.ingestPlaylistLabel) {
        if (intent.isExplicit) {
          this.ingestPlaylistLabel.textContent = `${platform} playlist detected — download as Series (with Autoplay)`;
        } else if (intent.hasListParam && !intent.isAutoMix) {
          this.ingestPlaylistLabel.textContent = 'Playlist found in URL — check to download full playlist as Series (Autoplay)';
        } else {
          this.ingestPlaylistLabel.textContent = 'Download playlist / multi-video collection as a Series (with Autoplay)';
        }
      }
    } else {
      this.ingestPlatformBadge.style.display = 'none';
      if (this.ingestPlaylistRow) {
        this.ingestPlaylistRow.style.display = 'none';
      }
      if (this.downloadPlaylistCheckbox) {
        this.downloadPlaylistCheckbox.checked = false;
      }
    }
  }

  renderView() {
    // If Live TV is active, show the Live TV container and hide standard views
    if (this.activeFilter === 'livetv') {
      this.heroSection.style.display = 'none';
      this.carouselsContainer.style.display = 'none';
      this.gridContainer.style.display = 'none';
      this.emptyState.style.display = 'none';
      if (this.livetvContainer) this.livetvContainer.style.display = 'block';
      this.loadLiveTvData();
      return;
    }

    if (this.livetvContainer) this.livetvContainer.style.display = 'none';

    const isBrowsingHome = this.activeFilter === 'all' && !this.searchTerm;

    if (isBrowsingHome) {
      this.gridContainer.style.display = 'none';
      this.emptyState.style.display = 'none';

      if (!this.featuredItem || this.isPrivateOrAdultItem(this.featuredItem)) {
        this.selectNextFeaturedItem();
      }

      const hero = this.featuredItem;
      if (hero && !this.isPrivateOrAdultItem(hero)) {
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

      const recentFeed = buildRecentlyAddedFeed(this.mediaItems, this.seriesList, 18);
      html += renderCarousel('recent', 'Recently Added to GCS', recentFeed, renderCatalogCard);

      if (this.seriesList.length > 0) {
        html += renderCarousel('series', 'TV Series & Shows', this.seriesList, renderSeriesCard);
      }

      const movies = sortMoviesList(
        this.mediaItems.filter((m) => m.type === 'movie'),
        'recent'
      );
      if (movies.length > 0) {
        html += renderCarousel('movies', 'Movies', movies);
      }

      const documentaries = collapseGroupedMedia(
        sortMoviesList(
          this.mediaItems.filter((m) => this.isDocumentaryItem(m)),
          'recent'
        ),
        this.seriesList
      );
      if (documentaries.length > 0) {
        html += renderCarousel('documentary', 'Documentaries', documentaries, renderCatalogCard);
      }

      const others = collapseGroupedMedia(
        sortMoviesList(
          this.mediaItems.filter((m) => this.isOthersItem(m)),
          'recent'
        ),
        this.seriesList
      );
      if (others.length > 0) {
        html += renderCarousel('others', 'Others & Social Clips', others, renderCatalogCard);
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
      const showSortBar = ['movie', 'documentary', 'others'].includes(this.activeFilter);
      if (this.gridSortBar) {
        this.gridSortBar.style.display = showSortBar ? 'flex' : 'none';
        if (showSortBar) {
          this.gridSortBar.querySelectorAll('.movie-sort-chip').forEach((chip) => {
            chip.classList.toggle('active', chip.dataset.movieSort === this.movieSortOrder);
          });
        }
      }

      if (this.activeFilter === 'series') {
        let filteredSeries = this.seriesList;
        if (this.searchTerm) {
          const q = this.searchTerm;
          filteredSeries = filteredSeries.filter((s) => {
            const matchTitle = (s.title || s.series_name)?.toLowerCase().includes(q);
            const matchPlot = s.plot?.toLowerCase().includes(q);
            const matchGenres = s.genres?.some((g) => g.toLowerCase().includes(q));
            return matchTitle || matchPlot || matchGenres;
          });
          this.gridTitle.textContent = `TV Series matching "${this.searchTerm}" (${filteredSeries.length})`;
        } else {
          this.gridTitle.textContent = `TV Series & Shows (${filteredSeries.length})`;
        }

        if (filteredSeries.length === 0) {
          this.gridContent.innerHTML = '';
          this.emptyState.style.display = 'block';
        } else {
          this.emptyState.style.display = 'none';
          this.gridContent.innerHTML = filteredSeries.map(renderSeriesCard).join('');
        }
        return;
      }

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
              document.querySelectorAll('.nav-item[data-filter="all"]').forEach((b) => b.classList.add('active'));
              this.activeFilter = 'all';
              this.renderView();
            };
          }
        }, 0);
      } else if (this.activeFilter === 'movie') {
        filtered = sortMoviesList(
          filtered.filter((m) => m.type === 'movie'),
          this.movieSortOrder
        );
        this.gridTitle.textContent = `Movies (${filtered.length})`;
      } else if (this.activeFilter === 'documentary') {
        filtered = collapseGroupedMedia(
          sortMoviesList(
            filtered.filter((m) => this.isDocumentaryItem(m)),
            this.movieSortOrder
          ),
          this.seriesList
        );
        this.gridTitle.textContent = `Documentary (${filtered.length})`;
      } else if (this.activeFilter === 'others') {
        filtered = collapseGroupedMedia(
          sortMoviesList(
            filtered.filter((m) => this.isOthersItem(m)),
            this.movieSortOrder
          ),
          this.seriesList
        );
        this.gridTitle.textContent = `Others & Playlists (${filtered.length})`;
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
        if (!['movie', 'continue', 'vault'].includes(this.activeFilter)) {
          filtered = collapseGroupedMedia(filtered, this.seriesList);
        }
        this.gridTitle.textContent = `Results for "${this.searchTerm}" (${filtered.length})`;
      }

      if (filtered.length === 0) {
        this.gridContent.innerHTML = '';
        this.emptyState.style.display = 'block';
      } else {
        this.emptyState.style.display = 'none';
        this.gridContent.innerHTML = filtered.map(renderCatalogCard).join('');
      }
    }
  }

  openDetailModal(item) {
    this.activeMedia = item;
    const pin = vaultState.getPin();
    const pinParam = (item.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
    const thumbUrl = `/api/media/${item.id}/thumbnail?variant=69${pinParam}`;
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

    // Set Resume or Play label
    const startTime = (item.current_time && item.current_time > 10) ? item.current_time : 0;
    if (startTime > 10) {
      const formatted = this.formatTime(startTime);
      this.detailPlayBtn.innerHTML = `
        <span class="material-symbols-outlined fill">play_arrow</span>
        <span>Resume (${formatted})</span>
      `;
    } else {
      this.detailPlayBtn.innerHTML = `
        <span class="material-symbols-outlined fill">play_arrow</span>
        <span>Play</span>
      `;
    }

    // Enforce Owner-only admin buttons inside Media Details Modal
    const isOwner = profileState.isOwner();
    [this.detailRetagBtn, this.detailFixMatchBtn, this.detailSubtitleBtn, this.detailVaultBtn, this.detailDeleteBtn].forEach((btn) => {
      if (btn) btn.style.display = isOwner ? 'inline-flex' : 'none';
    });

    if (this.detailCategorySection) {
      this.detailCategorySection.style.display = isOwner ? 'block' : 'none';
      if (isOwner && this.detailCategoryPills) {
        const activeCat = this.isDocumentaryItem(item)
          ? 'documentary'
          : this.isOthersItem(item)
            ? 'others'
            : item.type === 'series'
              ? 'series'
              : 'movie';
        this.detailCategoryPills.querySelectorAll('.detail-category-chip').forEach((chip) => {
          chip.classList.toggle('active', chip.dataset.category === activeCat);
        });
      }
    }

    // Set Vault Button state
    if (this.detailVaultBtn && this.detailVaultIcon && this.detailVaultText) {
      if (item.is_adult) {
        this.detailVaultIcon.textContent = 'lock_open';
        this.detailVaultText.textContent = 'Move to Public';
      } else {
        this.detailVaultIcon.textContent = 'lock';
        this.detailVaultText.textContent = 'Move to Vault';
      }
    }

    if (this.detailFixMatchRow) {
      this.detailFixMatchRow.style.display = 'none';
    }
    if (this.detailFixMatchInput) {
      this.detailFixMatchInput.value = '';
    }

    this.detailModal.classList.add('open');
  }

  async handleRetagMedia(matchHint = '') {
    if (!this.activeMedia) return;

    const cleanHint = typeof matchHint === 'string' ? matchHint.trim() : '';
    this.detailRetagBtn.disabled = true;
    if (this.detailFixMatchApply) this.detailFixMatchApply.disabled = true;
    this.detailRetagBtn.innerHTML = `
      <span class="material-symbols-outlined" style="animation: spin 1s infinite linear;">refresh</span>
      <span>Searching &amp; Grounding...</span>
    `;

    try {
      const res = await api.retagMedia(this.activeMedia.id, cleanHint);
      if (res.item) {
        this.activeMedia = res.item;
        this.openDetailModal(res.item);
        await this.loadData();
        if (this.seriesModal && this.seriesModal.classList.contains('open') && this.currentSeriesData?.series) {
          const targetSeries = res.item.series_name || this.currentSeriesData.series.series_name || this.currentSeriesData.series.title;
          if (targetSeries) {
            await this.openSeriesModal(targetSeries);
          }
        }
      }
    } catch (err) {
      console.error('Failed to retag:', err);
      alert(`Re-tag failed: ${err.message}`);
    } finally {
      this.detailRetagBtn.disabled = false;
      if (this.detailFixMatchApply) this.detailFixMatchApply.disabled = false;
      this.detailRetagBtn.innerHTML = `
        <span class="material-symbols-outlined">auto_awesome</span>
        <span>Re-tag with AI</span>
      `;
    }
  }

  async handleRetagSeries(seriesName, matchHint = '') {
    if (!seriesName) return;
    const retagBtn = document.getElementById('series-retag-btn');
    const applyBtn = document.getElementById('series-fix-match-apply-btn');
    if (retagBtn) {
      retagBtn.disabled = true;
      retagBtn.innerHTML = `
        <span class="material-symbols-outlined" style="animation: spin 1s infinite linear;">refresh</span>
        <span>Grounding All Episodes...</span>
      `;
    }
    if (applyBtn) applyBtn.disabled = true;

    try {
      const res = await api.retagSeries(seriesName, typeof matchHint === 'string' ? matchHint.trim() : '');
      await this.loadData();
      const updatedSeriesName = res?.seriesName || seriesName;
      await this.openSeriesModal(updatedSeriesName);
    } catch (err) {
      console.error('Failed to re-tag series:', err);
      alert(`Series re-tag failed: ${err.message}`);
      if (retagBtn) {
        retagBtn.disabled = false;
        retagBtn.innerHTML = `
          <span class="material-symbols-outlined">auto_awesome</span>
          <span>Re-tag Series</span>
        `;
      }
      if (applyBtn) applyBtn.disabled = false;
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
    this.startDownloadModalPolling();
  }

  closeDownloadModal() {
    this.downloadModal.classList.remove('open');
    this.stopDownloadModalPolling();
  }

  startDownloadModalPolling() {
    if (this.downloadModalPollInterval) return;
    this.downloadModalPollInterval = setInterval(() => {
      if (this.downloadModal && this.downloadModal.classList.contains('open')) {
        this.loadDownloads(true);
      } else {
        this.stopDownloadModalPolling();
      }
    }, 2000);
  }

  stopDownloadModalPolling() {
    if (this.downloadModalPollInterval) {
      clearInterval(this.downloadModalPollInterval);
      this.downloadModalPollInterval = null;
    }
  }

  async loadDownloads(isSilent = false) {
    if (!profileState.isOwner()) {
      this.closeDownloadStream();
      return;
    }
    try {
      const res = await api.getDownloads();
      const list = res.downloads || [];
      const activeCount = list.filter((d) => ['downloading', 'uploading', 'queued'].includes(d.status)).length;

      if (activeCount > 0) {
        this.downloadCountBadge.textContent = activeCount;
        this.downloadCountBadge.style.display = 'flex';
        this.setupDownloadStream();
      } else {
        this.downloadCountBadge.style.display = 'none';
        this.closeDownloadStream();
      }

      if (list.length === 0) {
        this.downloadQueueList.innerHTML = `
          <div style="text-align: center; color: var(--md-sys-color-outline); padding: 32px 0; font-size: 13px;">
            No active downloads. Paste a magnet or video link above.
          </div>
        `;
      } else {
        const existingItems = Array.from(this.downloadQueueList.querySelectorAll('.download-item'));
        const existingIds = existingItems.map((el) => el.id.replace('dl-', ''));
        const newIds = list.map((d) => d.id);
        const idsMatch = existingIds.length === newIds.length && existingIds.every((id, idx) => id === newIds[idx]);

        if (idsMatch) {
          list.forEach((dl) => {
            const itemEl = document.getElementById(`dl-${dl.id}`);
            if (itemEl) {
              itemEl.outerHTML = renderDownloadItem(dl);
            }
          });
        } else {
          this.downloadQueueList.innerHTML = list.map(renderDownloadItem).join('');
        }
      }
    } catch (err) {
      if (!isSilent) console.error('Failed to load downloads:', err);
    }
  }

  async handleStartDownload(e) {
    e.preventDefault();
    if (!profileState.isOwner()) return;
    const url = this.downloadUrlInput.value.trim();
    const name = this.downloadNameInput.value.trim();
    const category = this.downloadCategorySelect ? this.downloadCategorySelect.value : '';
    const isSocial = Boolean(this.detectClientSocialPlatform(url));
    const playlist = isSocial && this.downloadPlaylistCheckbox ? Boolean(this.downloadPlaylistCheckbox.checked) : undefined;
    const maxItems = isSocial && this.downloadPlaylistLimit ? Number(this.downloadPlaylistLimit.value) || 50 : undefined;
    if (!url) return;

    try {
      await api.startDownload(url, name, category, { playlist, maxItems });
      this.downloadUrlInput.value = '';
      this.downloadNameInput.value = '';
      if (this.downloadCategorySelect) this.downloadCategorySelect.value = '';
      if (this.ingestPlatformBadge) this.ingestPlatformBadge.style.display = 'none';
      if (this.ingestPlaylistRow) this.ingestPlaylistRow.style.display = 'none';
      if (this.downloadPlaylistCheckbox) this.downloadPlaylistCheckbox.checked = false;
      this.loadDownloads();
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    }
  }

  async handleDirectFilesUpload(fileList) {
    if (!profileState.isOwner()) return;
    if (!fileList || fileList.length === 0) return;
    const uploadCategory = this.uploadCategorySelect ? this.uploadCategorySelect.value : '';

    for (const file of Array.from(fileList)) {
      // Check if .torrent file
      if (file.name.toLowerCase().endsWith('.torrent')) {
        try {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const dataUrl = reader.result;
              const base64 = dataUrl.split(',')[1];
              await api.uploadTorrentFile(file.name, base64, uploadCategory);
              this.loadDownloads();
              // Switch back to remote link tab to show download queue
              if (this.tabBtnLink) this.tabBtnLink.click();
            } catch (err) {
              alert(`Torrent ingestion failed: ${err.message}`);
            }
          };
          reader.readAsDataURL(file);
        } catch (torrentErr) {
          alert(`Failed to read torrent file: ${torrentErr.message}`);
        }
        continue;
      }

      // Direct Video File Upload to GCS
      const uploadId = 'up-' + Math.random().toString(36).substring(2, 9);
      const itemEl = document.createElement('div');
      itemEl.id = uploadId;
      itemEl.className = 'upload-file-item';
      itemEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 8px; max-width: 80%;">
            <span class="material-symbols-outlined" style="color: var(--md-sys-color-primary); font-size: 20px;">video_file</span>
            <span style="font-size: 13px; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHtml(file.name)}
            </span>
          </div>
          <span style="font-size: 11px; color: var(--md-sys-color-on-surface-variant);">${this.formatSize(file.size)}</span>
        </div>
        <div style="width: 100%; height: 6px; background-color: var(--md-sys-color-surface-container-highest); border-radius: 9999px; overflow: hidden; margin-bottom: 6px;">
          <div class="upload-bar" style="height: 100%; width: 0%; background-color: var(--md-sys-color-primary); transition: width 0.2s ease;"></div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--md-sys-color-on-surface-variant);">
          <span class="upload-percent">0%</span>
          <span class="upload-status" style="color: var(--md-sys-color-primary);">Requesting upload URL...</span>
        </div>
      `;

      if (this.uploadProgressContainer) {
        this.uploadProgressContainer.style.display = 'block';
      }
      if (this.uploadProgressList) {
        this.uploadProgressList.prepend(itemEl);
      }

      const barEl = itemEl.querySelector('.upload-bar');
      const pctEl = itemEl.querySelector('.upload-percent');
      const statusEl = itemEl.querySelector('.upload-status');

      try {
        const reqRes = await api.requestUploadUrl(file.name, file.size, file.type || 'application/octet-stream', uploadCategory);
        const uploadUrl = reqRes.uploadUrl;
        const downloadId = reqRes.downloadId;

        statusEl.textContent = 'Uploading to Cloud Storage...';

        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

        let lastTime = Date.now();
        let lastLoaded = 0;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            let speedStr = '';
            if (elapsed >= 0.8) {
              const speed = (e.loaded - lastLoaded) / elapsed;
              speedStr = ` (${this.formatSize(speed)}/s)`;
              lastTime = now;
              lastLoaded = e.loaded;
            }
            if (barEl) barEl.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
            if (statusEl) statusEl.textContent = `Uploading to Cloud Storage...${speedStr}`;
          }
        };

        xhr.onload = async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            if (barEl) {
              barEl.style.width = '100%';
              barEl.style.backgroundColor = '#4caf50';
            }
            if (pctEl) pctEl.textContent = '100%';
            if (statusEl) {
              statusEl.style.color = 'var(--md-sys-color-primary)';
              statusEl.textContent = 'Auto-tagging with Gemini AI...';
            }

            try {
              await api.completeUpload(file.name, file.size, downloadId, uploadCategory);
              if (statusEl) {
                statusEl.style.color = '#4caf50';
                statusEl.textContent = '✓ Saved & added to library!';
              }
              this.loadData();
              this.loadDownloads();
            } catch (compErr) {
              if (statusEl) {
                statusEl.style.color = '#f44336';
                statusEl.textContent = 'Uploaded, but tagging error: ' + compErr.message;
              }
              this.loadData();
            }
          } else {
            if (statusEl) {
              statusEl.style.color = '#f44336';
              statusEl.textContent = `Upload failed (status ${xhr.status})`;
            }
          }
        };

        xhr.onerror = () => {
          if (statusEl) {
            statusEl.style.color = '#f44336';
            statusEl.textContent = 'Network error during upload';
          }
        };

        xhr.send(file);
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = '#f44336';
          statusEl.textContent = `Upload error: ${err.message}`;
        }
      }
    }
  }

  closeDownloadStream() {
    if (this.eventSource) {
      try { this.eventSource.close(); } catch (_) {}
      this.eventSource = null;
    }
  }

  setupDownloadStream() {
    if (this.eventSource && this.eventSource.readyState !== EventSource.CLOSED) {
      return;
    }
    const token = authState.getToken();
    if (!token) return;

    this.eventSource = new EventSource(`/api/downloads/events?token=${token}`);
    this.eventSource.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        if (update && update.type === 'idle') {
          this.closeDownloadStream();
          this.loadDownloads(true);
          return;
        }
        if (update && update.id) {
          const itemEl = document.getElementById(`dl-${update.id}`);
          if (itemEl) {
            itemEl.outerHTML = renderDownloadItem(update);
          } else {
            this.loadDownloads(true);
          }

          if (update.status === 'completed') {
            this.loadData();
            this.loadDownloads(true);
          } else if (update.status === 'failed' || update.status === 'paused') {
            this.loadDownloads(true);
          }
        }
      } catch (_) {}
    };
    this.eventSource.onerror = () => {
      // Close on error/EOF so browser does not loop reconnections when server scales to zero
      this.closeDownloadStream();
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

  async loadLiveTvData() {
    if (this.liveChannels.length > 0 && this.liveCategories.length > 0) {
      this.renderLiveTv();
      return;
    }

    if (this.livetvEmptyState) {
      this.livetvEmptyState.style.display = 'none';
    }
    if (this.livetvGrid) {
      this.livetvGrid.innerHTML = `
        <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 64px 0; gap: 14px; color: var(--md-sys-color-outline);">
          <span class="material-symbols-outlined" style="font-size: 38px; color: var(--md-sys-color-primary); animation: spin 1s infinite linear;">progress_activity</span>
          <span style="font-size: 14px;">Loading live television channels & EPG guide...</span>
        </div>
      `;
    }

    try {
      this.liveOffset = 0;
      const [catsRes, channelsRes] = await Promise.all([
        api.getLiveCategories(),
        api.getLiveChannels({
          limit: this.livePageLimit,
          offset: 0,
          verifiedOnly: this.liveVerifiedOnly ? 'true' : 'false',
        }),
      ]);

      this.liveCategories = catsRes.categories || [];
      this.liveCountries = catsRes.countries || [];
      this.liveChannels = channelsRes.channels || channelsRes.items || [];
      this.liveTotalCount = channelsRes.total ?? this.liveChannels.length;
      this.renderLiveTv();
    } catch (err) {
      console.error('Failed to load Live TV channels:', err);
      if (this.livetvGrid) {
        this.livetvGrid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 48px 0; color: var(--md-sys-color-outline);">
            Failed to load live channels. Please try again.
          </div>
        `;
      }
    }
  }

  async fetchLiveChannels(append = false) {
    if (!this.livetvGrid) return;

    // Immediately toggle chip active states in DOM
    if (this.livetvCategoryChips) {
      this.livetvCategoryChips.querySelectorAll('.live-cat-chip').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.category === this.activeLiveCategory.toLowerCase());
      });
    }
    if (this.livetvCountryChips) {
      this.livetvCountryChips.querySelectorAll('.live-country-chip').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.country === this.activeLiveCountry.toLowerCase());
      });
    }

    try {
      if (!append) {
        this.liveOffset = 0;
        this.livetvGrid.style.opacity = '0.4';
      } else {
        this.liveOffset = this.liveChannels.length;
      }

      const params = {
        limit: this.livePageLimit,
        offset: this.liveOffset,
        verifiedOnly: this.liveVerifiedOnly ? 'true' : 'false',
      };
      if (this.activeLiveCategory && this.activeLiveCategory !== 'all') {
        params.category = this.activeLiveCategory;
      }
      if (this.activeLiveCountry && this.activeLiveCountry !== 'all') {
        params.country = this.activeLiveCountry;
      }
      if (this.liveSearchTerm) {
        params.search = this.liveSearchTerm;
      }

      const res = await api.getLiveChannels(params);
      const nextItems = res.channels || res.items || [];
      this.liveChannels = append ? [...this.liveChannels, ...nextItems] : nextItems;
      this.liveTotalCount = res.total ?? this.liveChannels.length;
      this.renderLiveTvGrid();
    } catch (err) {
      console.error('Failed to fetch filtered live channels:', err);
    } finally {
      if (this.livetvGrid) this.livetvGrid.style.opacity = '1';
    }
  }

  renderLiveTv() {
    if (!this.livetvGrid) return;

    // Render Categories
    if (this.livetvCategoryChips) {
      const allCats = [
        { id: 'all', name: 'All Channels' },
        ...this.liveCategories.map((c) => (typeof c === 'string' ? { id: c.toLowerCase(), name: c } : c)),
      ];
      this.livetvCategoryChips.innerHTML = allCats.map((cat) => {
        const catId = (cat.id || cat.name || '').toLowerCase();
        const catName = cat.name || cat.id || '';
        const isActive = this.activeLiveCategory.toLowerCase() === catId;
        return `
          <button class="filter-chip live-cat-chip ${isActive ? 'active' : ''}" data-category="${escapeHtml(catId)}">
            ${escapeHtml(catName)}
          </button>
        `;
      }).join('');
    }

    // Render Countries (6 countries / 3 continents + Global)
    if (this.livetvCountryChips) {
      const allCountries = [
        { id: 'all', name: 'All Regions' },
        ...this.liveCountries.map((c) => (typeof c === 'string' ? { id: c.toLowerCase(), name: c } : c)),
      ];
      this.livetvCountryChips.innerHTML = allCountries.map((c) => {
        const cId = (c.id || c.code || c.name || '').toLowerCase();
        const cName = c.name || c.id || c.code || '';
        const flag = c.flag ? `${c.flag} ` : '';
        const isActive = this.activeLiveCountry.toLowerCase() === cId;
        return `
          <button class="filter-chip live-country-chip ${isActive ? 'active' : ''}" data-country="${escapeHtml(cId)}">
            ${flag}${escapeHtml(cName)}
          </button>
        `;
      }).join('');
    }

    this.renderLiveTvGrid();
  }

  renderLiveTvGrid() {
    if (!this.livetvGrid) return;
    const channels = this.liveChannels;

    if (this.livetvTotalBadge) {
      const badgeCount = this.liveTotalCount ?? channels.length;
      this.livetvTotalBadge.textContent = this.liveVerifiedOnly
        ? `${badgeCount} Verified Channels`
        : `${badgeCount} Channels`;
    }

    if (channels.length === 0) {
      this.livetvGrid.innerHTML = '';
      if (this.livetvEmptyState) this.livetvEmptyState.style.display = 'block';
    } else {
      if (this.livetvEmptyState) this.livetvEmptyState.style.display = 'none';
      this.livetvGrid.innerHTML = channels.map(renderLiveChannelCard).join('');
    }

    if (this.livetvLoadMoreContainer) {
      const hasMore = channels.length < (this.liveTotalCount || 0);
      this.livetvLoadMoreContainer.style.display = hasMore ? 'block' : 'none';
    }
  }

  async openSeriesModal(seriesName) {
    if (!this.seriesModal || !this.seriesModalBody) return;
    this.seriesModal.classList.add('open');
    this.seriesModalBody.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; min-height: 400px;">
        <div style="display: flex; flex-direction: column; align-items: center; gap: 16px;">
          <div class="spinner"></div>
          <span style="font-size: 14px; color: var(--md-sys-color-outline);">Loading seasons & episodes...</span>
        </div>
      </div>
    `;

    try {
      const data = await api.getSeriesSeasons(seriesName);
      this.currentSeriesData = data;
      this.activeSeason = data.seasonNumbers?.[0] || 1;
      this.renderSeriesModal(data, this.activeSeason);
    } catch (err) {
      this.seriesModalBody.innerHTML = `
        <div style="padding: 48px; text-align: center; color: var(--md-sys-color-outline);">
          Failed to load series details: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }

  renderSeriesModal(seriesData, seasonNum) {
    if (!this.seriesModalBody) return;
    this.seriesModalBody.innerHTML = renderSeriesModalContent(seriesData, seasonNum, {
      isOwner: profileState.isOwner(),
    });
  }

  async openScheduleModal(channelId) {
    if (!this.scheduleModal || !this.scheduleModalBody) return;
    this.scheduleModal.classList.add('open');
    this.scheduleModalBody.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; min-height: 350px;">
        <div style="display: flex; flex-direction: column; align-items: center; gap: 16px;">
          <div class="spinner"></div>
          <span style="font-size: 14px; color: var(--md-sys-color-outline);">Loading 24-hour schedule guide...</span>
        </div>
      </div>
    `;

    try {
      const data = await api.getChannelSchedule(channelId);
      this.scheduleModalBody.innerHTML = renderScheduleModalContent(data);
    } catch (err) {
      this.scheduleModalBody.innerHTML = `
        <div style="padding: 48px; text-align: center; color: var(--md-sys-color-outline);">
          Failed to load TV guide schedule: ${escapeHtml(err.message)}
        </div>
      `;
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
