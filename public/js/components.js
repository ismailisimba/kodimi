/**
 * Kodimi Material 3 UI Component Generators
 */

export function renderHeroBanner(item) {
  if (!item) return '';

  const pin = sessionStorage.getItem('kodimi_vault_pin');
  const pinParam = (item.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const heroThumb = `/api/media/${item.id}/thumbnail?variant=69${pinParam}`;
  let backdrop = item.backdrop_url || item.poster_url || heroThumb;
  if (backdrop.includes('placehold.co')) {
    backdrop = heroThumb;
  }
  const badges = [];

  if (item.type === 'series') {
    badges.push(`<span class="chip chip-primary">Series</span>`);
  } else {
    badges.push(`<span class="chip chip-primary">Featured</span>`);
  }

  if (item.year) {
    badges.push(`<span class="chip chip-outline">${item.year}</span>`);
  }

  if (item.resolution) {
    badges.push(`<span class="chip chip-outline">${item.resolution.toUpperCase()}</span>`);
  }

  if (item.genres && item.genres.length > 0) {
    badges.push(`<span class="chip">${item.genres.slice(0, 2).join(' • ')}</span>`);
  }

  return `
    <div class="hero-backdrop">
      <img src="${backdrop}" alt="${escapeHtml(item.title)}" loading="eager" onerror="this.onerror=null; this.src='${heroThumb}';" />
      <div class="hero-gradient-overlay"></div>
    </div>
    <div class="hero-content">
      <div class="hero-badges">${badges.join('')}</div>
      <h1 class="hero-title">${escapeHtml(item.title)}</h1>
      <p class="hero-plot">${escapeHtml(item.plot || 'Stream seamlessly on Kodimi with adaptive multi-resolution.')}</p>
      <div class="hero-actions">
        <button class="btn-filled" id="hero-play-btn" data-id="${item.id}">
          <span class="material-symbols-outlined fill">play_arrow</span>
          <span>Play</span>
        </button>
        <button class="btn-tonal" id="hero-info-btn" data-id="${item.id}">
          <span class="material-symbols-outlined">info</span>
          <span>More Info</span>
        </button>
      </div>
    </div>
  `;
}

export function renderMediaCard(item) {
  let poster = item.poster_url;
  const pin = sessionStorage.getItem('kodimi_vault_pin');
  const pinParam = (item.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  // Intersect randomly between 42% and 69% shots for cinematic variety
  const variant = Math.random() < 0.5 ? '42' : '69';
  const thumbUrl = `/api/media/${item.id}/thumbnail?variant=${variant}${pinParam}`;
  if (!poster || poster.includes('placehold.co') || item.is_adult) {
    poster = thumbUrl;
  }

  const progressPct = item.playback_duration && item.playback_duration > 0
    ? Math.min(100, Math.round((item.current_time / item.playback_duration) * 100))
    : 0;

  const startTime = item.current_time || 0;
  const isResume = startTime > 10;

  return `
    <div class="media-card" data-id="${item.id}" data-time="${startTime}">
      <img class="card-poster" src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="if(this.src.indexOf('/thumbnail') === -1) { this.src='${thumbUrl}'; }" />
      ${item.resolution ? `<span class="card-badge">${item.resolution}</span>` : ''}
      ${progressPct > 0 ? `
        <div class="card-progress-bar">
          <div class="card-progress-fill" style="width: ${progressPct}%"></div>
        </div>
      ` : ''}
      <div class="card-overlay">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-meta">
          ${item.year ? `<span>${item.year}</span>` : ''}
          ${item.genres && item.genres[0] ? `<span>• ${item.genres[0]}</span>` : ''}
        </div>
        <div class="card-quick-actions">
          <button class="quick-play-btn" data-id="${item.id}" data-time="${startTime}" title="${isResume ? 'Resume' : 'Play'}">
            <span class="material-symbols-outlined fill" style="font-size: 18px;">play_arrow</span>
          </button>
          <button class="quick-info-btn" data-id="${item.id}" title="More Info">
            <span class="material-symbols-outlined" style="font-size: 18px;">info</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderCarousel(sectionId, title, items) {
  if (!items || items.length === 0) return '';

  const cardsHtml = items.map(renderMediaCard).join('');

  return `
    <section class="media-section" id="section-${sectionId}">
      <div class="section-header">
        <h2 class="section-title">
          <span>${title}</span>
          <span class="section-count">(${items.length})</span>
        </h2>
      </div>
      <div class="carousel-container">
        <button class="carousel-nav-btn left" data-target="track-${sectionId}">
          <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <div class="carousel-track no-scrollbar" id="track-${sectionId}">
          ${cardsHtml}
        </div>
        <button class="carousel-nav-btn right" data-target="track-${sectionId}">
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
    </section>
  `;
}

export function renderDownloadItem(dl) {
  const isCompleted = dl.status === 'completed';
  const isFailed = dl.status === 'failed';
  const isDownloading = dl.status === 'downloading';

  const speedStr = formatSpeed(dl.speed);
  const sizeStr = dl.total_bytes > 0
    ? `${formatBytes(dl.downloaded_bytes)} / ${formatBytes(dl.total_bytes)}`
    : '';

  return `
    <div class="download-item" id="dl-${dl.id}" style="background-color: var(--md-sys-color-surface-container-high); border-radius: var(--md-shape-corner-m); padding: 12px 16px; margin-bottom: 8px; border: 1px solid var(--md-sys-color-outline-variant);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; max-width: 85%;">
          <span class="chip" style="font-size: 10px; padding: 2px 6px;">${dl.source_type}</span>
          <span style="font-size: 13px; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(dl.name)}
          </span>
        </div>
        <button class="icon-btn dl-cancel-btn" data-id="${dl.id}" title="Remove" style="width: 28px; height: 28px;">
          <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
        </button>
      </div>

      <div style="width: 100%; height: 6px; background-color: var(--md-sys-color-surface-container-highest); border-radius: 9999px; overflow: hidden; margin-bottom: 8px;">
        <div style="height: 100%; width: ${dl.progress || 0}%; background-color: ${isCompleted ? '#4caf50' : isFailed ? '#f44336' : 'var(--md-sys-color-primary)'}; transition: width 0.3s ease;"></div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--md-sys-color-on-surface-variant);">
        <div style="display: flex; gap: 12px;">
          <span>${Math.round(dl.progress || 0)}%</span>
          ${isDownloading ? `<span>${speedStr}</span>` : ''}
          ${sizeStr ? `<span>${sizeStr}</span>` : ''}
          ${dl.peers > 0 ? `<span>Peers: ${dl.peers}</span>` : ''}
        </div>
        <div>
          ${isCompleted ? '<span style="color: #4caf50;">✓ Saved to GCS</span>' : ''}
          ${isDownloading ? '<span style="color: var(--md-sys-color-primary);">Streaming to GCS...</span>' : ''}
          ${isFailed ? `<span style="color: #f44336;">${escapeHtml(dl.error || 'Failed')}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '0 KB/s';
  if (bytesPerSec > 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
