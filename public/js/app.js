/**
 * Kodimi Main Application Controller
 * Enhanced with Private Vault (PIN-protected), Material Design 3, & Multi-Resolution Player
 */
import { api, authState, vaultState, profileState } from './api.js?v=33';
import KodimiPlayer from './player.js?v=33';
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
  renderResetRequestCard,
  buildRecentlyAddedFeed,
  collapseGroupedMedia,
  sortMoviesList,
  escapeHtml,
} from './components.js?v=33';

// Feature-detect native Popover API and load polyfill only when missing
if (typeof HTMLElement !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
}

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
    this.resetRequests = [];
    this.seenResetRequestIds = new Set();
    this.pendingDeferredToastRequests = [];
    this.ownerPingPollInterval = null;
    this.lastOwnerPingCheckAt = 0;
    this.lockoutFromSwitchProfile = false;
    this.copyFeedbackTimers = new WeakMap();
    this.lastCopyAnnouncement = '';
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
    this.navMoreBtn = document.getElementById('nav-more-btn');
    this.navMoreLabel = document.getElementById('nav-more-label');
    this.navMorePopover = document.getElementById('nav-more-popover');

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
    this.loginModalTitle = document.getElementById('login-modal-title');
    this.loginModalSubtitle = document.getElementById('login-modal-subtitle');
    this.loginCodeStep = document.getElementById('login-code-step');
    this.loginForm = document.getElementById('login-form');
    this.loginPassword = document.getElementById('login-password');
    this.loginToggleVisibility = document.getElementById('login-toggle-visibility');
    this.loginSubmitBtn = document.getElementById('login-submit-btn');
    this.loginError = document.getElementById('login-error');

    this.loginLockoutStep = document.getElementById('login-lockout-step');
    this.loginLockoutHeading = document.getElementById('login-lockout-heading');
    this.lockoutResetForm = document.getElementById('lockout-reset-form');
    this.lockoutProfileName = document.getElementById('lockout-profile-name');
    this.lockoutResetError = document.getElementById('lockout-reset-error');
    this.lockoutResetSubmit = document.getElementById('lockout-reset-submit');
    this.lockoutCancelSessionBtn = document.getElementById('lockout-cancel-session-btn');

    this.loginLockoutSentStep = document.getElementById('login-lockout-sent-step');
    this.loginLockoutSentHeading = document.getElementById('login-lockout-sent-heading');
    this.lockoutSentSummary = document.getElementById('lockout-sent-summary');
    this.lockoutWaMessagePreview = document.getElementById('lockout-wa-message-preview');
    this.lockoutWaLink = document.getElementById('lockout-wa-link');
    this.lockoutCheckStatusBtn = document.getElementById('lockout-check-status-btn');
    this.lockoutSentReturnBtn = document.getElementById('lockout-sent-return-btn');
    this.lockoutStatusFeedback = document.getElementById('lockout-status-feedback');

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
    this.detailTagEditorForm = document.getElementById('detail-tag-editor-form');
    this.detailTagKindSelect = document.getElementById('detail-tag-kind-select');
    this.detailTagInput = document.getElementById('detail-tag-input');
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

    // Multi-Profile & Owner Alert Elements
    this.ownerAlertsBtn = document.getElementById('owner-alerts-btn');
    this.ownerAlertsBadge = document.getElementById('owner-alerts-badge');
    this.profileSwitcherBtn = document.getElementById('profile-switcher-btn');
    this.navProfileAvatar = document.getElementById('nav-profile-avatar');
    this.navProfileName = document.getElementById('nav-profile-name');
    this.profileDropdown = document.getElementById('profile-dropdown');
    this.profileDropdownHeader = document.getElementById('profile-dropdown-header');
    this.dropdownSwitchProfileBtn = document.getElementById('dropdown-switch-profile-btn');
    this.dropdownChangeCodeBtn = document.getElementById('dropdown-change-code-btn');
    this.dropdownOwnerDivider = document.getElementById('dropdown-owner-divider');
    this.dropdownResetRequestsBtn = document.getElementById('dropdown-reset-requests-btn');
    this.dropdownResetRequestsCount = document.getElementById('dropdown-reset-requests-count');
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
    this.profileEditGenerateCodeBtn = document.getElementById('profile-edit-generate-code-btn');
    this.profileEditPasscodeHint = document.getElementById('profile-edit-passcode-hint');
    this.profileEditAvatarPreview = document.getElementById('profile-edit-avatar-preview');
    this.profileColorSwatches = document.getElementById('profile-color-swatches');
    this.profileEditKidsToggle = document.getElementById('profile-edit-kids-toggle');
    this.profileEditError = document.getElementById('profile-edit-error');
    this.profileEditDeleteBtn = document.getElementById('profile-edit-delete-btn');
    this.profileEditCancelBtn = document.getElementById('profile-edit-cancel-btn');

    // Owner Reset Requests Native Dialog & Notifications
    this.resetRequestsDialog = document.getElementById('reset-requests-dialog');
    this.resetRequestsClose = document.getElementById('reset-requests-close');
    this.resetRequestsList = document.getElementById('reset-requests-list');
    this.resetSuccessBanner = document.getElementById('reset-success-banner');
    this.resetSuccessTitle = document.getElementById('reset-success-title');
    this.resetSuccessBody = document.getElementById('reset-success-body');
    this.resetNewCodeOutput = document.getElementById('reset-new-code-output');
    this.resetShareWaLink = document.getElementById('reset-share-wa-link');
    this.toastRegion = document.getElementById('toast-region');
    this.srAnnouncer = document.getElementById('sr-announcer');
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

    // Navigation Overflow Popover (sync aria-expanded & fallback anchor positioning for Firefox/older Safari)
    if (this.navMorePopover && this.navMoreBtn) {
      const positionFallbackPopover = () => {
        if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('position-area', 'block-end')) {
          return;
        }
        const trigRect = this.navMoreBtn.getBoundingClientRect();
        const popRect = this.navMorePopover.getBoundingClientRect();
        const gap = 8;
        let top = trigRect.bottom + gap;
        if (top + popRect.height > window.innerHeight - gap && trigRect.top - popRect.height - gap >= gap) {
          top = trigRect.top - popRect.height - gap;
        }
        const left = Math.max(gap, Math.min(trigRect.left, window.innerWidth - popRect.width - gap));
        this.navMorePopover.style.top = `${Math.round(top)}px`;
        this.navMorePopover.style.left = `${Math.round(left)}px`;
      };

      this.navMorePopover.addEventListener('toggle', (event) => {
        const isOpen = event.newState === 'open';
        this.navMoreBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
          requestAnimationFrame(positionFallbackPopover);
        }
      });
    }

    // Navigation Tabs
    this.navItems.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const filter = btn.dataset.filter;
        this.closeMoreNavPopover();

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

        this.setActiveNavFilter(filter);
        this.activeFilter = filter;
        this.renderView();
      });
    });

    document.getElementById('brand-home').addEventListener('click', () => {
      this.closeMoreNavPopover();
      this.setActiveNavFilter('all');
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
      this.stopOwnerPingMonitoring();
      authState.clearToken();
      vaultState.lock();
      profileState.setActiveProfile(null);
      this.profiles = [];
      this.resetRequests = [];
      this.privateItems = [];
      this.applyRolePermissionsUI();
      this.openLoginModalWithLockoutCheck();
    });

    // Login Form & Lockout Reset Form
    this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));
    if (this.loginPassword) {
      this.loginPassword.addEventListener('input', () => {
        this.loginPassword.removeAttribute('aria-invalid');
        if (this.loginError) this.loginError.hidden = true;
      });
    }
    if (this.loginToggleVisibility && this.loginPassword) {
      this.loginToggleVisibility.addEventListener('click', () => {
        const showing = this.loginPassword.type === 'text';
        this.loginPassword.type = showing ? 'password' : 'text';
        this.loginToggleVisibility.setAttribute('aria-pressed', showing ? 'false' : 'true');
        this.loginToggleVisibility.setAttribute('aria-label', showing ? 'Show login code' : 'Hide login code');
        const icon = this.loginToggleVisibility.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = showing ? 'visibility' : 'visibility_off';
      });
    }
    if (this.lockoutResetForm) {
      this.lockoutResetForm.addEventListener('submit', (e) => this.handleLockoutResetRequest(e));
    }
    if (this.lockoutProfileName) {
      this.lockoutProfileName.addEventListener('input', () => {
        this.lockoutProfileName.removeAttribute('aria-invalid');
        if (this.lockoutResetError) this.lockoutResetError.hidden = true;
      });
    }
    if (this.lockoutCheckStatusBtn) {
      this.lockoutCheckStatusBtn.addEventListener('click', () => this.handleCheckLockoutStatus());
    }
    const handleReturnFromLockout = () => {
      if (this.lockoutFromSwitchProfile && authState.isAuthenticated()) {
        this.lockoutFromSwitchProfile = false;
        this.loginModal.classList.remove('open');
        this.flushDeferredToasts();
      }
    };
    if (this.lockoutCancelSessionBtn) {
      this.lockoutCancelSessionBtn.addEventListener('click', handleReturnFromLockout);
    }
    if (this.lockoutSentReturnBtn) {
      this.lockoutSentReturnBtn.addEventListener('click', handleReturnFromLockout);
    }

    // Switch Profile (Code-only) Form
    if (this.switchProfileForm) {
      this.switchProfileForm.addEventListener('submit', (e) => this.handleSwitchProfile(e));
    }
    if (this.switchProfileCode) {
      this.switchProfileCode.addEventListener('input', () => {
        this.switchProfileCode.removeAttribute('aria-invalid');
        if (this.switchProfileError) this.switchProfileError.hidden = true;
      });
    }
    if (this.switchProfileCancel) {
      this.switchProfileCancel.addEventListener('click', () => {
        if (this.switchProfileModal) this.switchProfileModal.classList.remove('open');
        this.flushDeferredToasts();
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

    // Detail Modal Individual Tag / Genre Editor (Owner-only)
    if (this.detailTagEditorForm) {
      this.detailTagEditorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!this.activeMedia || !profileState.isOwner() || !this.detailTagInput) return;
        const raw = this.detailTagInput.value.trim();
        if (!raw) return;
        const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
        if (values.length === 0) return;
        const kind = this.detailTagKindSelect ? this.detailTagKindSelect.value : 'tag';
        const payload = kind === 'genre' ? { addGenres: values } : { addTags: values };
        try {
          const res = await api.updateMediaTags(this.activeMedia.id, payload);
          if (res?.item) {
            this.detailTagInput.value = '';
            this.activeMedia = res.item;
            this.openDetailModal(res.item);
            await this.loadData();
          }
        } catch (err) {
          alert(`Failed to add ${kind}: ${err.message}`);
        }
      });
    }

    const handleDetailChipRemove = async (e) => {
      const btn = e.target.closest('.detail-remove-tag-btn, .detail-remove-genre-btn');
      if (!btn || !this.activeMedia || !profileState.isOwner()) return;
      const isGenre = btn.classList.contains('detail-remove-genre-btn');
      const val = isGenre ? btn.dataset.genre : btn.dataset.tag;
      if (!val) return;
      try {
        btn.disabled = true;
        const payload = isGenre ? { removeGenres: [val] } : { removeTags: [val] };
        const res = await api.updateMediaTags(this.activeMedia.id, payload);
        if (res?.item) {
          this.activeMedia = res.item;
          this.openDetailModal(res.item);
          await this.loadData();
        }
      } catch (err) {
        alert(`Failed to remove ${isGenre ? 'genre' : 'tag'}: ${err.message}`);
      }
    };
    if (this.detailGenres) this.detailGenres.addEventListener('click', handleDetailChipRemove);
    if (this.detailTags) this.detailTags.addEventListener('click', handleDetailChipRemove);

    // Series / Playlist Modal Tag / Genre Editor submit (Owner-only)
    document.addEventListener('submit', async (e) => {
      const form = e.target.closest('#series-tag-editor-form');
      if (!form || !profileState.isOwner()) return;
      e.preventDefault();
      const seriesName = form.dataset.seriesName;
      const input = form.querySelector('#series-tag-input');
      const kindEl = form.querySelector('#series-tag-kind-select');
      const raw = input ? input.value.trim() : '';
      if (!seriesName || !raw) return;
      const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (values.length === 0) return;
      const kind = kindEl ? kindEl.value : 'tag';
      const payload = kind === 'genre' ? { addGenres: values } : { addTags: values };
      try {
        const isAdult = Boolean(this.currentSeriesData?.series?.is_adult);
        const res = await api.updateSeriesTags(seriesName, payload, isAdult);
        if (res?.data) {
          this.currentSeriesData = res.data;
          this.renderSeriesModal(this.currentSeriesData, this.activeSeason || 1);
          await this.loadData();
        }
      } catch (err) {
        alert(`Failed to tag collection: ${err.message}`);
      }
    });

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

      // 3c2. Series / Playlist Bulk Category Move & Tag/Genre Removal (Owner-only)
      const seriesCatChip = e.target.closest('.series-category-chip');
      if (seriesCatChip && profileState.isOwner()) {
        const seriesName = seriesCatChip.dataset.seriesName;
        const category = seriesCatChip.dataset.category;
        if (seriesName && category) {
          seriesCatChip.disabled = true;
          const isAdult = Boolean(this.currentSeriesData?.series?.is_adult);
          api.updateSeriesCategory(seriesName, category, isAdult)
            .then(async (res) => {
              if (res?.data) {
                this.currentSeriesData = res.data;
                this.renderSeriesModal(this.currentSeriesData, this.activeSeason || 1);
                await this.loadData();
              }
            })
            .catch((err) => alert(`Failed to move collection: ${err.message}`))
            .finally(() => { seriesCatChip.disabled = false; });
        }
        return;
      }

      const seriesRemoveChip = e.target.closest('.series-remove-tag-btn, .series-remove-genre-btn');
      if (seriesRemoveChip && profileState.isOwner()) {
        const seriesName = seriesRemoveChip.dataset.seriesName;
        const isGenre = seriesRemoveChip.classList.contains('series-remove-genre-btn');
        const val = isGenre ? seriesRemoveChip.dataset.genre : seriesRemoveChip.dataset.tag;
        if (seriesName && val) {
          seriesRemoveChip.disabled = true;
          const isAdult = Boolean(this.currentSeriesData?.series?.is_adult);
          const payload = isGenre ? { removeGenres: [val] } : { removeTags: [val] };
          api.updateSeriesTags(seriesName, payload, isAdult)
            .then(async (res) => {
              if (res?.data) {
                this.currentSeriesData = res.data;
                this.renderSeriesModal(this.currentSeriesData, this.activeSeason || 1);
                await this.loadData();
              }
            })
            .catch((err) => alert(`Failed to remove ${isGenre ? 'genre' : 'tag'}: ${err.message}`));
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
          this.flushDeferredToasts();
        }
      });
    });

    this.initProfileEvents();
    this.initOwnerResetAndCopyEvents();

    window.addEventListener('kodimi_auth_required', () => {
      this.closeDownloadStream();
      this.stopOwnerPingMonitoring();
      this.applyRolePermissionsUI();
      this.openLoginModalWithLockoutCheck();
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
          this.switchProfileCode.removeAttribute('aria-invalid');
          if (this.switchProfileError) this.switchProfileError.hidden = true;
          this.switchProfileModal.classList.add('open');
          this.switchProfileCode.focus();
        }
      });
    }

    if (this.dropdownChangeCodeBtn) {
      this.dropdownChangeCodeBtn.addEventListener('click', () => {
        this.profileDropdown.style.display = 'none';
        if (!profileState.isOwner()) return;
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

    if (this.dropdownResetRequestsBtn) {
      this.dropdownResetRequestsBtn.addEventListener('click', () => {
        this.profileDropdown.style.display = 'none';
        if (!profileState.isOwner()) return;
        this.openResetRequestsDialog();
      });
    }

    if (this.dropdownManageProfilesBtn) {
      this.dropdownManageProfilesBtn.addEventListener('click', async () => {
        this.profileDropdown.style.display = 'none';
        if (!profileState.isOwner()) return;
        await Promise.all([this.loadProfiles(), this.loadResetRequests({ notifyNew: false })]);
        this.openProfileModal(true);
      });
    }

    if (this.profileEditGenerateCodeBtn && this.profileEditPasscode) {
      this.profileEditGenerateCodeBtn.addEventListener('click', async () => {
        if (!profileState.isOwner()) return;
        this.profileEditGenerateCodeBtn.disabled = true;
        try {
          const res = await api.generateProfileCode();
          if (res?.code) {
            this.profileEditPasscode.type = 'text';
            this.profileEditPasscode.value = res.code;
            this.profileEditPasscode.focus();
            this.profileEditPasscode.select();
          }
        } catch (err) {
          this.profileEditError.textContent = err.message || 'Could not generate a unique login code';
          this.profileEditError.style.display = 'block';
        } finally {
          this.profileEditGenerateCodeBtn.disabled = false;
        }
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
          await Promise.all([this.loadProfiles(), this.loadResetRequests({ notifyNew: false })]);
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
          await Promise.all([this.loadProfiles(), this.loadResetRequests({ notifyNew: false })]);
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

  closeMoreNavPopover() {
    if (!this.navMorePopover) return;
    try {
      if (this.navMorePopover.matches(':popover-open') || this.navMorePopover.classList.contains(':popover-open')) {
        this.navMorePopover.hidePopover();
      }
    } catch (_) {}
  }

  setActiveNavFilter(filter) {
    this.navItems.forEach((b) => {
      b.classList.remove('active');
      b.removeAttribute('aria-current');
    });
    document.querySelectorAll(`.nav-item[data-filter="${filter}"]`).forEach((b) => {
      b.classList.add('active');
      b.setAttribute('aria-current', 'page');
    });
    if (this.navMoreBtn) {
      const inMoreMenu = filter === 'continue' || filter === 'vault';
      this.navMoreBtn.classList.toggle('active', inMoreMenu);
      if (this.navMoreLabel) {
        this.navMoreLabel.textContent =
          filter === 'vault' ? 'Private' : filter === 'continue' ? 'Continue' : 'More';
      }
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
    if (this.ownerAlertsBtn) this.ownerAlertsBtn.style.display = isOwner ? 'flex' : 'none';
    if (this.dropdownChangeCodeBtn) this.dropdownChangeCodeBtn.style.display = isOwner ? 'flex' : 'none';
    if (this.dropdownResetRequestsBtn) this.dropdownResetRequestsBtn.style.display = isOwner ? 'flex' : 'none';
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
      this.setActiveNavFilter('all');
    }

    if (!isOwner) {
      this.stopOwnerPingMonitoring();
    } else {
      this.updateOwnerAlertsUI();
    }
  }

  renderProfileSelector() {
    if (!this.profilesGrid || !profileState.isOwner()) return;
    const active = profileState.getActiveProfile();
    const pendingProfileIds = new Set(
      (this.resetRequests || []).map((r) => r.matched_profile_id).filter(Boolean)
    );
    let html = this.profiles
      .map((p) => renderProfileCard(p, true, pendingProfileIds.has(p.id)))
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
    this.flushDeferredToasts();
  }

  openProfileEditModal(profile = null) {
    if (!this.profileEditModal || !profileState.isOwner()) return;
    this.profileEditError.style.display = 'none';
    if (this.profileEditPasscode) {
      this.profileEditPasscode.type = 'password';
    }

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
      await this.openLoginModalWithLockoutCheck();
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
        this.startOwnerPingMonitoring();
      } else {
        this.stopOwnerPingMonitoring();
      }
    } catch {
      this.applyRolePermissionsUI();
      await this.openLoginModalWithLockoutCheck();
    }
  }

  async openLoginModalWithLockoutCheck(fromSwitch = false) {
    this.lockoutFromSwitchProfile = Boolean(fromSwitch);
    this.loginModal.classList.add('open');
    try {
      const status = await api.getLockoutStatus();
      if (status?.locked) {
        this.showLoginLockoutView({
          requestSent: false,
          fromSwitch: this.lockoutFromSwitchProfile,
        });
        return;
      }
    } catch (_) {}
    this.showLoginCodeView();
  }

  showLoginCodeView(statusNote = '') {
    this.lockoutFromSwitchProfile = false;
    if (this.loginModalTitle) this.loginModalTitle.textContent = 'Sign in with your code';
    if (this.loginModalSubtitle) this.loginModalSubtitle.textContent = 'Enter your personal profile login code';
    if (this.loginCodeStep) this.loginCodeStep.hidden = false;
    if (this.loginLockoutStep) this.loginLockoutStep.hidden = true;
    if (this.loginLockoutSentStep) this.loginLockoutSentStep.hidden = true;
    if (this.loginError) {
      this.loginError.textContent = statusNote;
      this.loginError.hidden = !statusNote;
    }
    if (this.loginPassword) {
      this.loginPassword.removeAttribute('aria-invalid');
      this.loginPassword.focus();
    }
  }

  showLoginLockoutView({ requestSent = false, requestedName = '', whatsappMessage = '', whatsappUrl = '', fromSwitch = false } = {}) {
    this.lockoutFromSwitchProfile = Boolean(fromSwitch && authState.isAuthenticated());
    if (this.loginCodeStep) this.loginCodeStep.hidden = true;

    if (requestSent) {
      if (this.loginModalTitle) this.loginModalTitle.textContent = 'Reset request sent';
      if (this.loginModalSubtitle) this.loginModalSubtitle.textContent = 'Message the owner on WhatsApp to finish resetting your code';
      if (this.loginLockoutStep) this.loginLockoutStep.hidden = true;
      if (this.loginLockoutSentStep) this.loginLockoutSentStep.hidden = false;
      if (this.lockoutSentSummary) {
        this.lockoutSentSummary.textContent = `The owner was pinged in Kodimi for "${requestedName}". Message them on WhatsApp to confirm and receive your new login code.`;
      }
      if (this.lockoutWaMessagePreview) {
        this.lockoutWaMessagePreview.textContent = whatsappMessage;
      }
      if (this.lockoutWaLink) {
        this.lockoutWaLink.href = whatsappUrl || `https://wa.me/?text=${encodeURIComponent(whatsappMessage)}`;
      }
      if (this.lockoutStatusFeedback) {
        this.lockoutStatusFeedback.hidden = true;
        this.lockoutStatusFeedback.textContent = '';
      }
      if (this.lockoutSentReturnBtn) {
        this.lockoutSentReturnBtn.hidden = !this.lockoutFromSwitchProfile;
      }
      if (this.loginLockoutSentHeading) this.loginLockoutSentHeading.focus();
    } else {
      if (this.loginModalTitle) this.loginModalTitle.textContent = 'Sign-in locked';
      if (this.loginModalSubtitle) this.loginModalSubtitle.textContent = '5 failed attempts reached';
      if (this.loginLockoutStep) this.loginLockoutStep.hidden = false;
      if (this.loginLockoutSentStep) this.loginLockoutSentStep.hidden = true;
      if (this.lockoutResetError) {
        this.lockoutResetError.hidden = true;
        this.lockoutResetError.textContent = '';
      }
      if (this.lockoutCancelSessionBtn) {
        this.lockoutCancelSessionBtn.hidden = !this.lockoutFromSwitchProfile;
      }
      if (this.lockoutProfileName) {
        this.lockoutProfileName.value = '';
        this.lockoutProfileName.removeAttribute('aria-invalid');
        this.lockoutProfileName.focus();
      }
    }
  }

  async handleLogin(e) {
    e.preventDefault();
    const code = this.loginPassword.value.trim();
    if (!code) {
      if (this.loginError) {
        this.loginError.textContent = 'Enter your personal login code';
        this.loginError.hidden = false;
      }
      this.loginPassword.setAttribute('aria-invalid', 'true');
      this.loginPassword.focus();
      return;
    }

    if (this.loginError) this.loginError.hidden = true;
    this.loginPassword.removeAttribute('aria-invalid');
    if (this.loginSubmitBtn) this.loginSubmitBtn.disabled = true;

    try {
      await api.login(code);
      this.loginModal.classList.remove('open');
      this.loginPassword.value = '';
      this.loginPassword.type = 'password';
      if (this.loginToggleVisibility) {
        this.loginToggleVisibility.setAttribute('aria-pressed', 'false');
        this.loginToggleVisibility.setAttribute('aria-label', 'Show login code');
        const icon = this.loginToggleVisibility.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = 'visibility';
      }

      this.applyRolePermissionsUI();
      this.loadData();
      if (profileState.isOwner()) {
        this.loadProfiles();
        this.loadDownloads();
        this.startOwnerPingMonitoring();
      } else {
        this.closeDownloadStream();
        this.stopOwnerPingMonitoring();
      }
    } catch (err) {
      if (err?.locked || err?.status === 423) {
        this.loginPassword.value = '';
        this.showLoginLockoutView({ requestSent: false, fromSwitch: false });
        return;
      }
      if (this.loginError) {
        this.loginError.textContent = err.message || 'Incorrect login code';
        this.loginError.hidden = false;
      }
      this.loginPassword.setAttribute('aria-invalid', 'true');
      this.loginPassword.focus();
    } finally {
      if (this.loginSubmitBtn) this.loginSubmitBtn.disabled = false;
    }
  }

  async handleLockoutResetRequest(e) {
    e.preventDefault();
    const profileName = this.lockoutProfileName ? this.lockoutProfileName.value.trim() : '';
    if (!profileName) {
      if (this.lockoutResetError) {
        this.lockoutResetError.textContent = 'Enter your profile name so the owner knows which profile to reset';
        this.lockoutResetError.hidden = false;
      }
      if (this.lockoutProfileName) {
        this.lockoutProfileName.setAttribute('aria-invalid', 'true');
        this.lockoutProfileName.focus();
      }
      return;
    }

    if (this.lockoutResetError) this.lockoutResetError.hidden = true;
    if (this.lockoutResetSubmit) this.lockoutResetSubmit.disabled = true;

    try {
      const res = await api.requestProfileReset(profileName);
      this.showLoginLockoutView({
        requestSent: true,
        requestedName: res.requestedName || profileName,
        whatsappMessage: res.whatsappMessage || '',
        whatsappUrl: res.whatsappUrl || '',
        fromSwitch: this.lockoutFromSwitchProfile,
      });
    } catch (err) {
      if (this.lockoutResetError) {
        this.lockoutResetError.textContent = err.message || 'Could not alert the owner';
        this.lockoutResetError.hidden = false;
      }
      if (this.lockoutProfileName) {
        this.lockoutProfileName.setAttribute('aria-invalid', 'true');
        this.lockoutProfileName.focus();
      }
    } finally {
      if (this.lockoutResetSubmit) this.lockoutResetSubmit.disabled = false;
    }
  }

  async handleCheckLockoutStatus() {
    if (this.lockoutCheckStatusBtn) this.lockoutCheckStatusBtn.disabled = true;
    try {
      const status = await api.getLockoutStatus();
      if (!status?.locked) {
        this.showLoginCodeView();
        this.announceStatus('Sign-in is unlocked. Enter your login code.');
      } else if (this.lockoutStatusFeedback) {
        this.lockoutStatusFeedback.textContent = 'Sign-in is still locked. Message the owner on WhatsApp so they can reset your profile.';
        this.lockoutStatusFeedback.hidden = false;
      }
    } catch (_) {
      if (this.lockoutStatusFeedback) {
        this.lockoutStatusFeedback.textContent = 'Could not check status right now. Try again in a moment.';
        this.lockoutStatusFeedback.hidden = false;
      }
    } finally {
      if (this.lockoutCheckStatusBtn) this.lockoutCheckStatusBtn.disabled = false;
    }
  }

  async handleSwitchProfile(e) {
    e.preventDefault();
    const code = this.switchProfileCode.value.trim();
    if (!code) {
      if (this.switchProfileError) {
        this.switchProfileError.textContent = 'Enter the target profile login code';
        this.switchProfileError.hidden = false;
      }
      this.switchProfileCode.setAttribute('aria-invalid', 'true');
      this.switchProfileCode.focus();
      return;
    }

    if (this.switchProfileError) this.switchProfileError.hidden = true;
    this.switchProfileCode.removeAttribute('aria-invalid');
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
        this.startOwnerPingMonitoring();
      } else {
        this.stopOwnerPingMonitoring();
      }
    } catch (err) {
      if (err?.locked || err?.status === 423) {
        this.switchProfileCode.value = '';
        if (this.switchProfileModal) this.switchProfileModal.classList.remove('open');
        this.loginModal.classList.add('open');
        this.showLoginLockoutView({ requestSent: false, fromSwitch: true });
        return;
      }
      if (this.switchProfileError) {
        this.switchProfileError.textContent = err.message || 'Incorrect login code';
        this.switchProfileError.hidden = false;
      }
      this.switchProfileCode.setAttribute('aria-invalid', 'true');
      this.switchProfileCode.focus();
    }
  }

  initOwnerResetAndCopyEvents() {
    // 1. Copy button via native Invoker Commands (`command="--copy"`) with click fallback
    const handleCopyCommand = (button, target) => {
      if (button && target) this.copyTargetText(button, target);
    };
    if (typeof window !== 'undefined' && 'CommandEvent' in window) {
      document.addEventListener(
        'command',
        (event) => {
          if (event.command === '--copy') {
            handleCopyCommand(event.source, event.target);
          }
        },
        true
      );
    } else {
      document.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        const button = event.target.closest('button[command="--copy"]');
        if (!button) return;
        const targetId = button.getAttribute('commandfor');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) handleCopyCommand(button, target);
      });
    }

    // 2. Progressive-enhancement light-dismiss fallback for Safari lacking `dialog.closedBy`
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => {
          pressedOutside = isOutside(e, dialog);
        });
        dialog.addEventListener('pointerup', (e) => {
          if (pressedOutside && isOutside(e, dialog)) {
            dialog.close();
          }
          pressedOutside = false;
        });
      }
    }

    // 3. Owner notification bell & native <dialog> lifecycle
    if (this.ownerAlertsBtn) {
      this.ownerAlertsBtn.addEventListener('click', () => {
        if (!profileState.isOwner()) return;
        this.openResetRequestsDialog();
      });
    }

    if (this.resetRequestsClose && this.resetRequestsDialog) {
      this.resetRequestsClose.addEventListener('click', () => {
        this.resetRequestsDialog.close();
      });
    }

    if (this.resetRequestsDialog) {
      this.resetRequestsDialog.addEventListener('close', () => {
        this.resetRequestsDialog.returnValue = '';
        if (this.resetSuccessBanner) this.resetSuccessBanner.hidden = true;
        this.flushDeferredToasts();
      });

      // Delegated clicks inside Reset Requests dialog (Generate, Unlock only, Dismiss)
      this.resetRequestsDialog.addEventListener('click', async (e) => {
        const genBtn = e.target.closest('.reset-generate-btn');
        if (genBtn) {
          const inputId = genBtn.dataset.targetInput;
          const targetInput = inputId ? document.getElementById(inputId) : null;
          genBtn.disabled = true;
          try {
            const res = await api.generateProfileCode();
            if (res?.code && targetInput) {
              targetInput.value = res.code;
              targetInput.focus();
              targetInput.select();
            }
          } catch (_) {
          } finally {
            genBtn.disabled = false;
          }
          return;
        }

        const unlockBtn = e.target.closest('.reset-unlock-only-btn');
        if (unlockBtn) {
          const reqId = unlockBtn.dataset.requestId;
          if (!reqId) return;
          unlockBtn.disabled = true;
          try {
            await api.resolveResetRequest(reqId, { action: 'unlock_only' });
            await this.loadResetRequests({ notifyNew: false });
            this.renderResetRequestsDialog();
            this.announceStatus('Sign-in unlocked for this user.');
          } catch (err) {
            const card = unlockBtn.closest('.reset-request-card');
            const errEl = card?.querySelector('.reset-request-error');
            if (errEl) {
              errEl.textContent = err.message || 'Could not unlock sign-in';
              errEl.hidden = false;
            }
          } finally {
            unlockBtn.disabled = false;
          }
          return;
        }

        const dismissBtn = e.target.closest('.reset-dismiss-btn');
        if (dismissBtn) {
          const reqId = dismissBtn.dataset.requestId;
          if (!reqId) return;
          dismissBtn.disabled = true;
          try {
            await api.resolveResetRequest(reqId, { action: 'dismiss' });
            await this.loadResetRequests({ notifyNew: false });
            this.renderResetRequestsDialog();
          } catch (err) {
            const card = dismissBtn.closest('.reset-request-card');
            const errEl = card?.querySelector('.reset-request-error');
            if (errEl) {
              errEl.textContent = err.message || 'Could not dismiss request';
              errEl.hidden = false;
            }
          } finally {
            dismissBtn.disabled = false;
          }
        }
      });

      // Delegated submit for Reset Code & Unlock
      this.resetRequestsDialog.addEventListener('submit', async (e) => {
        const form = e.target.closest('.reset-request-form');
        if (!form) return;
        e.preventDefault();

        const reqId = form.dataset.requestId;
        const selectEl = form.querySelector('select[name="profileId"]');
        const codeEl = form.querySelector('input[name="newPasscode"]');
        const errEl = form.querySelector('.reset-request-error');
        const submitBtn = form.querySelector('.reset-submit-btn');

        const profileId = selectEl ? selectEl.value : '';
        const newPasscode = codeEl ? codeEl.value.trim() : '';

        if (errEl) errEl.hidden = true;
        if (!profileId) {
          if (errEl) {
            errEl.textContent = 'Select which profile to reset';
            errEl.hidden = false;
          }
          selectEl?.focus();
          return;
        }
        if (newPasscode && newPasscode.length < 4) {
          if (errEl) {
            errEl.textContent = 'Login code must be at least 4 characters';
            errEl.hidden = false;
          }
          codeEl?.focus();
          return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
          const res = await api.resolveResetRequest(reqId, {
            action: 'reset',
            profileId,
            newPasscode: newPasscode || undefined,
            generateCode: !newPasscode,
          });

          if (this.resetSuccessBanner && res?.newCode) {
            if (this.resetSuccessTitle) {
              this.resetSuccessTitle.textContent = `${res.profile?.name || 'Profile'} reset and unlocked`;
            }
            if (this.resetSuccessBody) {
              this.resetSuccessBody.textContent = 'Share this new unique login code with the user on WhatsApp. Previous sessions for this profile were signed out.';
            }
            if (this.resetNewCodeOutput) {
              this.resetNewCodeOutput.textContent = res.newCode;
            }
            if (this.resetShareWaLink) {
              this.resetShareWaLink.href = res.shareWhatsappUrl || `https://wa.me/?text=${encodeURIComponent(res.shareMessage || res.newCode)}`;
            }
            this.resetSuccessBanner.hidden = false;
          }

          await Promise.all([this.loadProfiles(), this.loadResetRequests({ notifyNew: false })]);
          this.renderResetRequestsDialog();
          if (this.isManagingProfiles) {
            this.renderProfileSelector();
          }
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message || 'Could not reset profile';
            errEl.hidden = false;
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    // 4. Refresh pending owner pings immediately when Owner switches back from WhatsApp
    const handleOwnerTabReturn = () => {
      if (!profileState.isOwner() || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - this.lastOwnerPingCheckAt < 4000) return;
      this.loadResetRequests({ notifyNew: true });
    };
    document.addEventListener('visibilitychange', handleOwnerTabReturn);
    window.addEventListener('focus', handleOwnerTabReturn);
  }

  legacyCopyText(text) {
    const previousFocus = document.activeElement;
    const field = Object.assign(document.createElement('textarea'), { value: text });
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } finally {
      field.remove();
      previousFocus?.focus({ preventScroll: true });
    }
  }

  async copyTargetText(button, target) {
    const text = target.matches('input, textarea') ? target.value : target.innerText.trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!this.legacyCopyText(text)) {
        throw new Error('Copy failed');
      }
      this.reportCopyFeedback(button, true);
    } catch {
      const ok = this.legacyCopyText(text);
      this.reportCopyFeedback(button, ok);
    }
  }

  reportCopyFeedback(button, ok) {
    const tip = button.nextElementSibling;
    const icon = button.querySelector('.copy-icon');
    clearTimeout(this.copyFeedbackTimers.get(button));
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');

    let message = ok ? 'Copied' : 'Copy failed';
    if (message === this.lastCopyAnnouncement) message += '\u00A0';
    this.lastCopyAnnouncement = message;

    if (tip) tip.textContent = '';
    if (icon) icon.textContent = ok ? 'check' : 'error';
    void button.offsetWidth;
    button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
    requestAnimationFrame(() => {
      if (tip) tip.textContent = message;
    });

    this.copyFeedbackTimers.set(
      button,
      setTimeout(() => {
        button.removeAttribute('data-copied');
        button.removeAttribute('data-failed');
        if (icon) icon.textContent = 'content_copy';
        if (tip) tip.textContent = '';
      }, 2000)
    );
  }

  announceStatus(message) {
    if (!message) return;
    if (typeof document.ariaNotify === 'function') {
      try {
        document.ariaNotify(message);
        return;
      } catch (_) {}
    }
    if (this.srAnnouncer) {
      this.srAnnouncer.textContent = '';
      requestAnimationFrame(() => {
        this.srAnnouncer.textContent = message;
      });
    }
  }

  isAnyModalOpen() {
    if (document.querySelector('.modal-backdrop.open')) return true;
    if (document.querySelector('dialog[open]')) return true;
    return false;
  }

  startOwnerPingMonitoring() {
    if (!profileState.isOwner()) return;
    this.loadResetRequests({ notifyNew: true });
    if (this.ownerPingPollInterval) return;
    this.ownerPingPollInterval = setInterval(() => {
      if (!profileState.isOwner()) {
        this.stopOwnerPingMonitoring();
        return;
      }
      if (document.visibilityState === 'visible') {
        this.loadResetRequests({ notifyNew: true });
      }
    }, 25000);
  }

  stopOwnerPingMonitoring() {
    if (this.ownerPingPollInterval) {
      clearInterval(this.ownerPingPollInterval);
      this.ownerPingPollInterval = null;
    }
    this.resetRequests = [];
    this.seenResetRequestIds.clear();
    this.pendingDeferredToastRequests = [];
    this.updateOwnerAlertsUI();
    if (this.toastRegion) {
      this.toastRegion.querySelectorAll('.kodimi-toast').forEach((t) => {
        try { t.hidePopover?.(); } catch (_) {}
        t.remove();
      });
    }
  }

  async loadResetRequests({ notifyNew = false } = {}) {
    if (!profileState.isOwner()) return;
    this.lastOwnerPingCheckAt = Date.now();
    try {
      const res = await api.getResetRequests();
      const incoming = Array.isArray(res?.requests) ? res.requests : [];
      const brandNew = incoming.filter((r) => !this.seenResetRequestIds.has(r.id));
      incoming.forEach((r) => this.seenResetRequestIds.add(r.id));

      this.resetRequests = incoming;
      this.updateOwnerAlertsUI();

      if (this.resetRequestsDialog?.open) {
        this.renderResetRequestsDialog();
      }

      if (notifyNew && brandNew.length > 0) {
        if (this.isAnyModalOpen()) {
          this.pendingDeferredToastRequests.push(...brandNew);
        } else {
          this.showResetRequestToast(brandNew);
        }
      }
    } catch (_) {
      // Silent fallback when offline or switching profiles
    }
  }

  updateOwnerAlertsUI() {
    const count = Array.isArray(this.resetRequests) ? this.resetRequests.length : 0;
    if (this.ownerAlertsBadge) {
      this.ownerAlertsBadge.textContent = String(count);
      this.ownerAlertsBadge.hidden = count === 0;
    }
    if (this.ownerAlertsBtn) {
      this.ownerAlertsBtn.classList.toggle('has-pending', count > 0);
      this.ownerAlertsBtn.setAttribute(
        'aria-label',
        count > 0 ? `Profile reset requests (${count} pending)` : 'Profile reset requests'
      );
    }
    if (this.dropdownResetRequestsCount) {
      this.dropdownResetRequestsCount.textContent = String(count);
      this.dropdownResetRequestsCount.hidden = count === 0;
    }
  }

  flushDeferredToasts() {
    if (this.isAnyModalOpen() || !profileState.isOwner()) return;
    if (this.pendingDeferredToastRequests.length === 0) return;
    const queued = this.pendingDeferredToastRequests.splice(0);
    const stillPending = queued.filter((q) => this.resetRequests.some((r) => r.id === q.id));
    if (stillPending.length > 0) {
      this.showResetRequestToast(stillPending);
    }
  }

  showResetRequestToast(newRequests) {
    if (!this.toastRegion || !Array.isArray(newRequests) || newRequests.length === 0) return;
    if (this.isAnyModalOpen()) {
      this.pendingDeferredToastRequests.push(...newRequests);
      return;
    }

    // Replace any existing reset-ping toast so the Owner gets a single clean persistent card
    this.toastRegion.querySelectorAll('.kodimi-toast').forEach((existing) => {
      try { existing.hidePopover?.(); } catch (_) {}
      existing.remove();
    });

    const first = newRequests[0];
    const toastId = `kodimi-reset-toast-${Date.now()}`;
    const titleText =
      newRequests.length === 1
        ? 'Profile reset requested'
        : `${newRequests.length} profile reset requests`;
    const bodyText =
      newRequests.length === 1
        ? `${first.requested_name} got locked out after 5 attempts and requested a code reset`
        : `${first.requested_name} and ${newRequests.length - 1} more requested a code reset`;

    const toastEl = document.createElement('div');
    toastEl.id = toastId;
    toastEl.className = 'kodimi-toast';
    toastEl.setAttribute('popover', 'manual');
    toastEl.innerHTML = `
      <div class="kodimi-toast-body">
        <div class="kodimi-toast-title">${escapeHtml(titleText)}</div>
        <div class="kodimi-toast-text">${escapeHtml(bodyText)}</div>
        <div class="kodimi-toast-actions">
          <button type="button" class="btn-filled kodimi-toast-btn kodimi-toast-review-btn">Review</button>
        </div>
      </div>
      <button
        type="button"
        class="icon-btn kodimi-toast-close"
        popovertarget="${toastId}"
        popovertargetaction="hide"
        aria-label="Close notification"
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    `;

    this.toastRegion.appendChild(toastEl);

    const reviewBtn = toastEl.querySelector('.kodimi-toast-review-btn');
    const closeBtn = toastEl.querySelector('.kodimi-toast-close');

    const closeToast = (returnFocus = false) => {
      const hadFocus = toastEl.contains(document.activeElement);
      try {
        toastEl.hidePopover?.();
      } catch (_) {
        toastEl.classList.remove(':popover-open');
      }
      toastEl.remove();
      if (returnFocus && hadFocus) {
        const nextToastBtn = this.toastRegion.querySelector('.kodimi-toast button');
        (nextToastBtn || this.ownerAlertsBtn)?.focus();
      }
    };

    if (reviewBtn) {
      reviewBtn.addEventListener('click', () => {
        closeToast(false);
        this.openResetRequestsDialog();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => closeToast(true));
    }
    toastEl.addEventListener('toggle', (ev) => {
      if (ev.newState === 'closed' && toastEl.isConnected) {
        toastEl.remove();
      }
    });

    try {
      if (typeof toastEl.showPopover === 'function') {
        toastEl.showPopover();
      } else {
        toastEl.classList.add(':popover-open');
      }
    } catch (_) {
      toastEl.classList.add(':popover-open');
    }

    this.announceStatus(`${titleText}. ${bodyText}. Actions available.`);
  }

  async openResetRequestsDialog() {
    if (!profileState.isOwner() || !this.resetRequestsDialog) return;
    if (this.resetSuccessBanner) this.resetSuccessBanner.hidden = true;
    await Promise.all([this.loadProfiles(), this.loadResetRequests({ notifyNew: false })]);
    this.renderResetRequestsDialog();
    if (!this.resetRequestsDialog.open) {
      this.resetRequestsDialog.showModal();
    }
  }

  renderResetRequestsDialog() {
    if (!this.resetRequestsList) return;
    if (!this.resetRequests || this.resetRequests.length === 0) {
      this.resetRequestsList.innerHTML = `
        <div class="reset-requests-empty">
          <span class="material-symbols-outlined" aria-hidden="true">verified_user</span>
          <div>No pending profile reset requests</div>
        </div>
      `;
      return;
    }

    this.resetRequestsList.innerHTML = this.resetRequests
      .map((reqItem) => renderResetRequestCard(reqItem, this.profiles))
      .join('');
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

      this.setActiveNavFilter('vault');
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
              this.setActiveNavFilter('all');
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

    const isOwner = profileState.isOwner();

    if (item.genres && item.genres.length > 0) {
      this.detailGenres.innerHTML = item.genres
        .map((g) =>
          isOwner
            ? `<span class="chip chip-removable">${escapeHtml(g)}<button type="button" class="chip-remove-btn detail-remove-genre-btn" data-genre="${escapeHtml(g)}" aria-label="Remove genre ${escapeHtml(g)}">&times;</button></span>`
            : `<span class="chip">${escapeHtml(g)}</span>`
        )
        .join('');
    } else {
      this.detailGenres.innerHTML = '';
    }

    if (item.tags && item.tags.length > 0) {
      this.detailTags.innerHTML = item.tags
        .map((t) =>
          isOwner
            ? `<span class="chip chip-outline chip-removable">#${escapeHtml(t)}<button type="button" class="chip-remove-btn detail-remove-tag-btn" data-tag="${escapeHtml(t)}" aria-label="Remove tag ${escapeHtml(t)}">&times;</button></span>`
            : `<span class="chip chip-outline">#${escapeHtml(t)}</span>`
        )
        .join('');
    } else {
      this.detailTags.innerHTML = '';
    }

    if (this.detailTagEditorForm) {
      this.detailTagEditorForm.style.display = isOwner ? 'flex' : 'none';
      if (this.detailTagInput) this.detailTagInput.value = '';
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
