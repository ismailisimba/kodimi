/**
 * Kodimi Material 3 UI Component Generators
 */

function getVaultPinSafe() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('kodimi_vault_pin') : null;
  } catch (_) {
    return null;
  }
}

function normalizeSeriesGroupKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getItemAddedMs(item) {
  if (!item || typeof item !== 'object') return 0;
  const candidates = [item.gcs_created_at, item.created_at, item.added_timestamp, item.updated_at];
  for (const val of candidates) {
    if (val === null || val === undefined || val === '') continue;
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return val;
    }
    const parsed = Date.parse(String(val));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

export function sortMoviesList(movies, sortOrder = 'recent') {
  if (!Array.isArray(movies)) return [];
  const copy = [...movies];
  const mode = String(sortOrder || 'recent').toLowerCase();

  if (mode === 'title') {
    copy.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    return copy;
  }

  if (mode === 'year') {
    copy.sort((a, b) => {
      const yearDiff = (Number(b.year) || 0) - (Number(a.year) || 0);
      if (yearDiff !== 0) return yearDiff;
      const addedDiff = getItemAddedMs(b) - getItemAddedMs(a);
      if (addedDiff !== 0) return addedDiff;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    return copy;
  }

  // Default: 'recent' (Newest GCS upload timestamp first)
  copy.sort((a, b) => {
    const addedDiff = getItemAddedMs(b) - getItemAddedMs(a);
    if (addedDiff !== 0) return addedDiff;
    const yearDiff = (Number(b.year) || 0) - (Number(a.year) || 0);
    if (yearDiff !== 0) return yearDiff;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
  return copy;
}

function isPlaylistCollection(item) {
  if (!item) return false;
  if (item.is_playlist) return true;
  return Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase() === 'playlist');
}

/**
 * Collapses items belonging to a shared `series_name` (TV Series, Docuseries, or Social/YouTube Playlists)
 * into a single Series/Playlist card while keeping standalone videos as individual cards.
 */
export function collapseGroupedMedia(mediaItems, seriesList = []) {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) return [];

  const seriesByKey = new Map();
  if (Array.isArray(seriesList)) {
    for (const s of seriesList) {
      const key = normalizeSeriesGroupKey(s.series_name || s.title);
      if (key && !seriesByKey.has(key)) {
        seriesByKey.set(key, s);
      }
    }
  }

  const groupStats = new Map();
  for (const m of mediaItems) {
    if (!m || !m.series_name) continue;
    const rawName = String(m.series_name).trim();
    const key = normalizeSeriesGroupKey(rawName);
    if (!key) continue;
    if (!groupStats.has(key)) {
      groupStats.set(key, {
        displayName: rawName,
        seasons: new Set(),
        episodesCount: 0,
        isPlaylist: isPlaylistCollection(m),
        sample: m,
        firstEp: null,
        latestAddedMs: getItemAddedMs(m),
      });
    }
    const st = groupStats.get(key);
    st.seasons.add(m.season || 1);
    st.episodesCount += 1;
    if (isPlaylistCollection(m)) st.isPlaylist = true;
    if ((m.season || 1) === 1 && m.episode === 1) st.firstEp = m;
    const ms = getItemAddedMs(m);
    if (ms > st.latestAddedMs) st.latestAddedMs = ms;
  }

  const seenKeys = new Set();
  const out = [];

  for (const item of mediaItems) {
    if (!item) continue;
    const isGrouped = item.type === 'series' || Boolean(item.series_name);
    if (!isGrouped) {
      out.push(item);
      continue;
    }

    const rawName = (item.series_name || String(item.title || '').replace(/\s*-\s*[sS]\d+[eE]\d+.*$/, '')).trim();
    const key = normalizeSeriesGroupKey(rawName);
    if (!key) {
      out.push(item);
      continue;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const existingSeries = seriesByKey.get(key);
    const st = groupStats.get(key);
    const sample = st?.firstEp || st?.sample || item;
    const isPlaylist = Boolean(st?.isPlaylist || isPlaylistCollection(existingSeries) || isPlaylistCollection(item));
    const useExistingSeries =
      Boolean(existingSeries) &&
      existingSeries.type === (item.type || 'series') &&
      (!st || st.episodesCount >= (existingSeries.episodes_count || 1));

    if (useExistingSeries) {
      out.push({
        ...existingSeries,
        is_series_group: true,
        is_playlist: isPlaylist,
        added_timestamp: Math.max(st?.latestAddedMs || 0, getItemAddedMs(existingSeries)),
      });
    } else {
      out.push({
        id: `series-${key.replace(/\s+/g, '-')}`,
        type: item.type || 'series',
        is_series_group: true,
        is_playlist: isPlaylist,
        series_name: st?.displayName || rawName,
        title: st?.displayName || rawName,
        year: sample.year || item.year,
        plot: sample.series_plot || item.series_plot || sample.plot || item.plot,
        genres: sample.genres || item.genres || [],
        tags: sample.tags || item.tags || [],
        poster_url: sample.poster_url || item.poster_url || '',
        backdrop_url: sample.backdrop_url || item.backdrop_url || '',
        seasons_count: st ? Math.max(1, st.seasons.size) : 1,
        episodes_count: st ? st.episodesCount : 1,
        sample_media_id: sample.id,
        is_adult: Boolean(item.is_adult),
        gcs_created_at: item.gcs_created_at || item.created_at || null,
        added_timestamp: st?.latestAddedMs || getItemAddedMs(item),
      });
    }
  }

  return out;
}

/**
 * Builds the Home "Recently Added to GCS" feed:
 * - Sorts all catalog items by newest GCS upload time (`gcs_created_at || created_at`).
 * - Collapses multiple episodes of the same TV series into a single Series card
 *   (so uploading a 10-episode season pack doesn't push every other title out of the carousel).
 * - Preserves chronological interleaving between newly uploaded Series and Movies.
 */
export function buildRecentlyAddedFeed(mediaItems, seriesList = [], limit = 18) {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) return [];

  const seriesByKey = new Map();
  if (Array.isArray(seriesList)) {
    for (const s of seriesList) {
      const key = normalizeSeriesGroupKey(s.series_name || s.title);
      if (key && !seriesByKey.has(key)) {
        seriesByKey.set(key, s);
      }
    }
  }

  // Count seasons & episodes across mediaItems as fallback when seriesList isn't populated
  const fallbackSeriesStats = new Map();
  for (const m of mediaItems) {
    const isEp = m && (m.type === 'series' || Boolean(m.series_name));
    if (!isEp) continue;
    const rawName = m.series_name || String(m.title || '').replace(/\s*-\s*[sS]\d+[eE]\d+.*$/, '').trim();
    const key = normalizeSeriesGroupKey(rawName);
    if (!key) continue;
      if (!fallbackSeriesStats.has(key)) {
        fallbackSeriesStats.set(key, {
          displayName: rawName || m.title,
          seasons: new Set(),
          episodesCount: 0,
          isPlaylist: isPlaylistCollection(m),
          firstEp: null,
          sample: m,
        });
      }
      const st = fallbackSeriesStats.get(key);
      st.seasons.add(m.season || 1);
      st.episodesCount += 1;
      if (isPlaylistCollection(m)) st.isPlaylist = true;
      if ((m.season || 1) === 1 && m.episode === 1) st.firstEp = m;
    }

  const sortedMedia = [...mediaItems].sort((a, b) => {
    const diff = getItemAddedMs(b) - getItemAddedMs(a);
    if (diff !== 0) return diff;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  const seenSeriesKeys = new Set();
  const feed = [];

  for (const item of sortedMedia) {
    if (!item) continue;
    const addedMs = getItemAddedMs(item);
    const isEpisode = item.type === 'series' || Boolean(item.series_name);

    if (isEpisode) {
      const rawSeriesName = item.series_name || String(item.title || '').replace(/\s*-\s*[sS]\d+[eE]\d+.*$/, '').trim();
      const key = normalizeSeriesGroupKey(rawSeriesName);
      if (key) {
        if (seenSeriesKeys.has(key)) {
          continue;
        }
        seenSeriesKeys.add(key);

        const existingSeries = seriesByKey.get(key);
        const stats = fallbackSeriesStats.get(key);
        const isPlaylist = Boolean(stats?.isPlaylist || isPlaylistCollection(existingSeries) || isPlaylistCollection(item));
        const sampleItem = stats?.firstEp || item;
        const seriesCardObj = existingSeries
          ? {
              ...existingSeries,
              is_series_group: true,
              is_playlist: isPlaylist,
              added_timestamp: Math.max(addedMs, getItemAddedMs(existingSeries)),
            }
          : {
              id: `series-${key.replace(/\s+/g, '-')}`,
              type: item.type || 'series',
              is_series_group: true,
              is_playlist: isPlaylist,
              series_name: stats?.displayName || rawSeriesName,
              title: stats?.displayName || rawSeriesName,
              year: sampleItem.year || item.year,
              plot: sampleItem.series_plot || item.series_plot || sampleItem.plot || item.plot,
              genres: sampleItem.genres || item.genres || [],
              tags: sampleItem.tags || item.tags || [],
              poster_url: sampleItem.poster_url || item.poster_url || '',
              backdrop_url: sampleItem.backdrop_url || item.backdrop_url || '',
              seasons_count: stats ? stats.seasons.size : 1,
              episodes_count: stats ? stats.episodesCount : 1,
              sample_media_id: sampleItem.id,
              is_adult: Boolean(item.is_adult),
              gcs_created_at: item.gcs_created_at || item.created_at || null,
              added_timestamp: addedMs,
            };

        feed.push(seriesCardObj);
      } else {
        feed.push(item);
      }
    } else {
      feed.push(item);
    }

    if (limit > 0 && feed.length >= limit) {
      break;
    }
  }

  return feed;
}

export function renderHeroBanner(item) {
  if (!item) return '';

  const pin = getVaultPinSafe();
  const pinParam = (item.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const thumbMediaId = item.sample_media_id || item.id;
  const heroThumb = `/api/media/${thumbMediaId}/thumbnail?variant=69${pinParam}`;
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

  const isSeries = item.type === 'series';
  const playLabel = isSeries ? 'Browse Series' : 'Play';
  const infoLabel = isSeries ? 'Episodes' : 'More Info';
  const seriesAttr = (isSeries && (item.series_name || item.title)) ? `data-series-name="${escapeHtml(item.series_name || item.title)}"` : '';

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
        <button class="btn-filled" id="hero-play-btn" data-id="${item.id}" ${seriesAttr}>
          <span class="material-symbols-outlined fill">play_arrow</span>
          <span>${playLabel}</span>
        </button>
        <button class="btn-tonal" id="hero-info-btn" data-id="${item.id}" ${seriesAttr}>
          <span class="material-symbols-outlined">info</span>
          <span>${infoLabel}</span>
        </button>
      </div>
    </div>
  `;
}

export function renderMediaCard(item) {
  let poster = item.poster_url;
  const pin = getVaultPinSafe();
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
  const categoryBadge =
    item.type === 'documentary'
      ? 'DOC'
      : item.type === 'others'
        ? 'OTHER'
        : '';

  return `
    <div class="media-card" data-id="${item.id}" data-time="${startTime}">
      <img class="card-poster" src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="if(this.src.indexOf('/thumbnail') === -1) { this.src='${thumbUrl}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=${encodeURIComponent(item.title.slice(0, 16))}'; }" />
      ${categoryBadge ? `<span class="card-badge" style="left: 8px; right: auto; background: rgba(0, 173, 181, 0.9); color: #fff;">${categoryBadge}</span>` : ''}
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
          ${isResume ? `
            <button class="quick-watched-btn" data-id="${item.id}" title="Mark as Watched (Remove from Continue Watching)">
              <span class="material-symbols-outlined" style="font-size: 18px;">check_circle</span>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

export function renderCarousel(sectionId, title, items, cardRenderer = renderMediaCard) {
  if (!items || items.length === 0) return '';

  const cardsHtml = items.map(cardRenderer).join('');

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
  const isPaused = dl.status === 'paused';
  const isQueued = dl.status === 'queued';

  const speedStr = formatSpeed(dl.speed);
  const sizeStr = dl.total_bytes > 0
    ? `${formatBytes(dl.downloaded_bytes)} / ${formatBytes(dl.total_bytes)}`
    : '';

  let actionButtonsHtml = '';
  if (isDownloading || isQueued) {
    actionButtonsHtml = `
      <button class="icon-btn dl-pause-btn" data-id="${dl.id}" title="Pause" style="width: 28px; height: 28px;">
        <span class="material-symbols-outlined" style="font-size: 18px;">pause</span>
      </button>
      <button class="icon-btn dl-delete-btn" data-id="${dl.id}" title="Delete" style="width: 28px; height: 28px; color: #ffb4ab;">
        <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
      </button>
    `;
  } else if (isPaused || isFailed) {
    actionButtonsHtml = `
      <button class="icon-btn dl-resume-btn" data-id="${dl.id}" title="Resume" style="width: 28px; height: 28px; color: var(--md-sys-color-primary);">
        <span class="material-symbols-outlined" style="font-size: 18px;">play_arrow</span>
      </button>
      <button class="icon-btn dl-delete-btn" data-id="${dl.id}" title="Delete" style="width: 28px; height: 28px; color: #ffb4ab;">
        <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
      </button>
    `;
  } else if (dl.status === 'uploading') {
    actionButtonsHtml = `
      <button class="icon-btn dl-delete-btn" data-id="${dl.id}" title="Cancel Upload" style="width: 28px; height: 28px; color: #ffb4ab;">
        <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
      </button>
    `;
  } else {
    actionButtonsHtml = `
      <button class="icon-btn dl-delete-btn" data-id="${dl.id}" title="Delete from list" style="width: 28px; height: 28px; color: #ffb4ab;">
        <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
      </button>
    `;
  }

  let statusColor = '#64b5f6';
  let statusText = dl.status_text || '';

  if (isCompleted) {
    statusColor = '#4caf50';
    statusText = '✓ Saved to GCS';
  } else if (isFailed) {
    statusColor = '#f44336';
    statusText = dl.error || dl.status_text || 'Failed';
  } else if (isPaused) {
    statusColor = '#ffb74d';
    statusText = '⏸ Paused';
  } else if (isQueued) {
    statusColor = '#ffb74d';
    statusText = dl.status_text || 'Queued...';
  } else if (dl.status === 'uploading') {
    statusColor = '#64b5f6';
    statusText = dl.status_text || 'Uploading to Cloud Storage...';
  } else if (isDownloading) {
    if (!statusText) {
      statusText = dl.speed > 0 ? 'Streaming to GCS...' : 'Connecting to peers...';
    }
    if (statusText.toLowerCase().includes('search') || statusText.toLowerCase().includes('waiting')) {
      statusColor = '#ffb74d';
    } else {
      statusColor = '#64b5f6';
    }
  }

  const statusDisplay = `<span style="color: ${statusColor};">${escapeHtml(statusText)}</span>`;
  const progressNum = Number(dl.progress || 0);
  const progressDisplay = progressNum >= 100 ? '100%' : `${progressNum.toFixed(1)}%`;

  return `
    <div class="download-item" id="dl-${dl.id}" style="background-color: var(--md-sys-color-surface-container-high); border-radius: var(--md-shape-corner-m); padding: 12px 16px; margin-bottom: 8px; border: 1px solid var(--md-sys-color-outline-variant);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; max-width: 75%;">
          <span class="chip" style="font-size: 10px; padding: 2px 6px;">${dl.source_type}</span>
          <span style="font-size: 13px; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(dl.name)}
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
          ${actionButtonsHtml}
        </div>
      </div>

      <div style="width: 100%; height: 6px; background-color: var(--md-sys-color-surface-container-highest); border-radius: 9999px; overflow: hidden; margin-bottom: 8px;">
        <div style="height: 100%; width: ${dl.progress || 0}%; background-color: ${isCompleted ? '#4caf50' : isFailed ? '#f44336' : isPaused ? '#ffb74d' : '#2196f3'}; transition: width 0.3s ease;"></div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--md-sys-color-on-surface-variant);">
        <div style="display: flex; gap: 12px;">
          <span>${progressDisplay}</span>
          ${isDownloading ? `<span>${speedStr}</span>` : ''}
          ${sizeStr ? `<span>${sizeStr}</span>` : ''}
          ${dl.peers > 0 ? `<span>Peers: ${dl.peers}</span>` : ''}
        </div>
        <div style="text-align: right; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${statusDisplay}
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
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderSeriesCard(series) {
  const pin = getVaultPinSafe();
  const pinParam = (series.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const fallbackThumb = series.sample_media_id ? `/api/media/${series.sample_media_id}/thumbnail?variant=69${pinParam}` : '';
  let poster = series.poster_url || fallbackThumb;
  if (!poster || poster.includes('placehold.co') || series.is_adult) {
    poster = fallbackThumb;
  }

  const isPlaylist = isPlaylistCollection(series);
  const seasonText = `${series.seasons_count || 1} Season${(series.seasons_count || 1) > 1 ? 's' : ''}`;
  const epCount = series.episodes_count || 1;
  const epText = isPlaylist ? `${epCount} Video${epCount > 1 ? 's' : ''}` : `${epCount} Ep${epCount > 1 ? 's' : ''}`;
  const badgeText = isPlaylist ? `Playlist • ${epText}` : `${seasonText} • ${epText}`;
  const browseTitle = isPlaylist ? 'Browse Playlist Videos' : 'Browse Seasons & Episodes';
  const infoTitle = isPlaylist ? 'Playlist Info' : 'Series Info';

  return `
    <div class="media-card series-card" data-series-name="${escapeHtml(series.series_name || series.title)}" data-sample-id="${series.sample_media_id || ''}">
      <img class="card-poster" src="${poster}" alt="${escapeHtml(series.title)}" loading="lazy" onerror="if(this.src.indexOf('/thumbnail') === -1 && '${fallbackThumb}') { this.src='${fallbackThumb}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=${encodeURIComponent(series.title.slice(0, 16))}'; }" />
      <span class="card-badge" style="background-color: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); font-weight: 700;">${badgeText}</span>
      <div class="card-overlay">
        <div class="card-title">${escapeHtml(series.title)}</div>
        <div class="card-meta">
          ${series.year ? `<span>${series.year}</span>` : ''}
          ${series.genres && series.genres[0] ? `<span>• ${series.genres[0]}</span>` : ''}
        </div>
        <div class="card-quick-actions">
          <button class="quick-play-btn series-browse-btn" data-series-name="${escapeHtml(series.series_name || series.title)}" title="${browseTitle}">
            <span class="material-symbols-outlined fill" style="font-size: 18px;">${isPlaylist ? 'playlist_play' : 'video_library'}</span>
          </button>
          <button class="quick-info-btn series-info-btn" data-series-name="${escapeHtml(series.series_name || series.title)}" title="${infoTitle}">
            <span class="material-symbols-outlined" style="font-size: 18px;">info</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderCatalogCard(item) {
  if (item && (item.is_series_group || String(item.id || '').startsWith('series-'))) {
    return renderSeriesCard(item);
  }
  return renderMediaCard(item);
}

export function renderLiveChannelCard(ch) {
  const cur = ch.currentProgram || {
    title: 'Live Broadcast',
    desc: 'Streaming live programming.',
    startTime: '',
    stopTime: '',
    progressPercent: 50,
    remainingMinutes: 30,
  };

  const next = ch.nextProgram;
  const timeLabel = cur.startTime && cur.stopTime ? `${cur.startTime} - ${cur.stopTime}` : 'Live Now';
  const isVerified = ch.healthStatus === 'verified';

  return `
    <div class="live-channel-card" data-channel-id="${ch.id}" data-stream-url="${escapeHtml(ch.streamUrl)}" data-name="${escapeHtml(ch.name)}">
      <div class="live-card-header">
        <div class="live-channel-info">
          <img class="live-channel-logo" src="${escapeHtml(ch.logo)}" alt="${escapeHtml(ch.name)}" onerror="this.src='https://placehold.co/80x80/1e1e1e/white?text=${encodeURIComponent(ch.name.slice(0,3))}';" />
          <div>
            <div class="live-channel-name">${escapeHtml(ch.name)}</div>
            <div class="live-channel-meta">
              <span class="live-badge">🔴 LIVE</span>
              ${isVerified ? `<span class="chip" style="font-size: 9px; padding: 1px 6px; background: rgba(76, 175, 80, 0.2); color: #81c784; border: 1px solid rgba(76, 175, 80, 0.45);">✓ VERIFIED</span>` : ''}
              <span class="chip chip-outline" style="font-size: 10px; padding: 1px 6px;">${ch.resolution || '720P'}</span>
              <span class="chip" style="font-size: 10px; padding: 1px 6px;">${escapeHtml(ch.category || 'General')}</span>
            </div>
          </div>
        </div>
        <button class="btn-filled live-play-btn" data-stream-url="${escapeHtml(ch.streamUrl)}" data-name="${escapeHtml(ch.name)}" data-channel-id="${ch.id}" style="padding: 6px 14px; font-size: 13px;">
          <span class="material-symbols-outlined fill" style="font-size: 16px;">play_arrow</span>
          <span>Watch</span>
        </button>
      </div>

      <div class="live-epg-now">
        <div class="epg-now-header">
          <span class="epg-now-tag">NOW SHOWING</span>
          <span class="epg-time-remain">${cur.remainingMinutes}m left • ${timeLabel}</span>
        </div>
        <div class="epg-now-title">${escapeHtml(cur.title)}</div>
        <p class="epg-now-desc">${escapeHtml(cur.desc)}</p>
        <div class="epg-progress-container">
          <div class="epg-progress-bar" style="width: ${cur.progressPercent || 0}%"></div>
        </div>
      </div>

      ${next ? `
        <div class="live-epg-next">
          <span class="epg-next-tag">UP NEXT:</span>
          <span class="epg-next-title">${escapeHtml(next.title)}</span>
          <span class="epg-next-time">(${next.startTime})</span>
        </div>
      ` : ''}

      <div class="live-card-actions">
        <button class="btn-tonal live-schedule-btn" data-channel-id="${ch.id}" style="width: 100%; justify-content: center; font-size: 12px; padding: 6px;">
          <span class="material-symbols-outlined" style="font-size: 16px;">calendar_month</span>
          <span>Full Schedule Guide</span>
        </button>
      </div>
    </div>
  `;
}

export function renderScheduleModalContent(data) {
  const ch = data.channel;
  const current = data.currentProgram;
  const schedule = data.schedule || [];

  const scheduleRows = schedule.map((item) => {
    const isNow = current && item.id === current.id;
    return `
      <div class="schedule-row ${isNow ? 'is-now-playing' : ''}">
        <div class="schedule-time">
          <span class="schedule-start">${item.startTime}</span>
          <span class="schedule-dur">${item.durationMinutes}m</span>
        </div>
        <div class="schedule-details">
          <div class="schedule-title">
            ${escapeHtml(item.title)}
            ${isNow ? '<span class="live-badge" style="margin-left: 8px;">NOW PLAYING</span>' : ''}
          </div>
          <div class="schedule-desc">${escapeHtml(item.desc)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="schedule-header">
      <img class="schedule-logo" src="${escapeHtml(ch.logo)}" alt="${escapeHtml(ch.name)}" onerror="this.src='https://placehold.co/100x100/1e1e1e/white?text=TV';" />
      <div style="flex: 1;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <h2 style="font-size: 22px; font-weight: 800; color: white; margin: 0;">${escapeHtml(ch.name)}</h2>
          <span class="live-badge">🔴 LIVE</span>
          <span class="chip" style="font-size: 11px;">${escapeHtml(ch.category)}</span>
        </div>
        <div style="font-size: 12px; color: var(--md-sys-color-on-surface-variant);">
          Today's 24-Hour Programming Schedule
        </div>
      </div>
      <button class="btn-filled live-play-btn" data-stream-url="${escapeHtml(ch.streamUrl)}" data-name="${escapeHtml(ch.name)}" data-channel-id="${ch.id}">
        <span class="material-symbols-outlined fill">play_arrow</span>
        <span>Watch Live</span>
      </button>
    </div>

    <div class="schedule-list no-scrollbar">
      ${scheduleRows}
    </div>
  `;
}

export function renderSeriesModalContent(seriesData, activeSeason = 1, options = {}) {
  const isOwner = options.isOwner !== false;
  const series = seriesData.series || {};
  const seasonsMap = seriesData.seasons || {};
  const seasonNumbers = seriesData.seasonNumbers || [1];
  const canonicalSeriesName = series.series_name || series.title || '';

  const pin = getVaultPinSafe();
  const pinParam = (series.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const fallbackThumb = series.sample_media_id ? `/api/media/${series.sample_media_id}/thumbnail?variant=69${pinParam}` : '';
  let backdrop = series.backdrop_url || series.poster_url || fallbackThumb;
  if (!backdrop || backdrop.includes('placehold.co')) {
    backdrop = fallbackThumb;
  }

  const isPlaylist = isPlaylistCollection(series);
  const totalItems = Object.values(seasonsMap).flat().length;
  const seriesGenres = Array.isArray(series.genres) ? series.genres : [];
  const seriesTags = Array.isArray(series.tags) ? series.tags : [];
  const activeSeriesCat =
    series.type === 'documentary' || seriesGenres.some((g) => String(g).toLowerCase() === 'documentary')
      ? 'documentary'
      : series.type === 'others' || seriesTags.some((t) => String(t).toLowerCase() === 'others')
        ? 'others'
        : 'series';

  const seriesGenresHtml = seriesGenres.map((g) =>
    isOwner
      ? `<span class="chip chip-removable">${escapeHtml(g)}<button type="button" class="chip-remove-btn series-remove-genre-btn" data-series-name="${escapeHtml(canonicalSeriesName)}" data-genre="${escapeHtml(g)}" aria-label="Remove genre ${escapeHtml(g)}">&times;</button></span>`
      : `<span class="chip">${escapeHtml(g)}</span>`
  ).join('');

  const seriesTagsHtml = seriesTags.map((t) =>
    isOwner
      ? `<span class="chip chip-outline chip-removable">#${escapeHtml(t)}<button type="button" class="chip-remove-btn series-remove-tag-btn" data-series-name="${escapeHtml(canonicalSeriesName)}" data-tag="${escapeHtml(t)}" aria-label="Remove tag ${escapeHtml(t)}">&times;</button></span>`
      : `<span class="chip chip-outline">#${escapeHtml(t)}</span>`
  ).join('');

  // Season Tabs HTML (hidden when single-list social playlist)
  const seasonTabsHtml = (isPlaylist && seasonNumbers.length <= 1)
    ? ''
    : seasonNumbers.map((sNum) => `
    <button class="season-tab-btn ${sNum === activeSeason ? 'active' : ''}" data-season="${sNum}">
      Season ${sNum} <span style="font-size: 11px; opacity: 0.8;">(${seasonsMap[sNum]?.length || 0})</span>
    </button>
  `).join('');

  // Active Season Episodes HTML
  const episodes = seasonsMap[activeSeason] || [];
  const episodesHtml = episodes.map((ep) => {
    const epThumb = `/api/media/${ep.id}/thumbnail?variant=42${pinParam}`;
    const isCompleted = Boolean(ep.completed);
    const startTime = isCompleted ? 0 : (ep.current_time || 0);
    const isResume = !isCompleted && startTime > 10;
    const durStr = ep.duration > 0
      ? (ep.duration < 60 ? `${Math.round(ep.duration)}s` : `${Math.round(ep.duration / 60)}m`)
      : 'HD';
    const progressPct = isCompleted
      ? 100
      : (ep.current_time && ep.playback_duration ? Math.min(100, (ep.current_time / ep.playback_duration) * 100) : 0);
    const epIdxLabel = isPlaylist ? `#${String(ep.episode || 1).padStart(2, '0')}` : `E${String(ep.episode || 1).padStart(2, '0')}`;
    const itemNumLabel = isPlaylist ? `Video ${ep.episode || 1}` : `Episode ${ep.episode || 1}`;

    return `
      <div class="series-episode-card" data-id="${ep.id}">
        <div class="episode-thumb-container">
          <img class="episode-thumb" src="${epThumb}" alt="${escapeHtml(ep.title)}" onerror="if(this.src.indexOf('/thumbnail') === -1 && '${fallbackThumb}') { this.src='${fallbackThumb}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=${encodeURIComponent(epIdxLabel)}'; }" />
          <button class="episode-play-overlay episode-play-btn" data-id="${ep.id}" data-time="${startTime}" title="${isResume ? 'Resume' : (isCompleted ? 'Watch Again' : 'Play')}">
            <span class="material-symbols-outlined fill" style="font-size: 28px;">play_arrow</span>
          </button>
          <span class="episode-badge">${epIdxLabel}${isCompleted ? ' ✓' : ''}</span>
          ${progressPct > 0 ? `
            <div class="episode-progress-bar">
              <div class="episode-progress-fill" style="width: ${progressPct}%;"></div>
            </div>
          ` : ''}
        </div>
        <div class="episode-info">
          <div class="episode-title-row">
            <span class="episode-number">${itemNumLabel}</span>
            <span class="episode-title">${escapeHtml(ep.title.replace(/^.*?[sS]\d+[eE]\d+:?\s*/, ''))}</span>
            <span class="episode-dur">${durStr}</span>
            <button type="button" class="episode-info-btn" data-id="${ep.id}" title="${isPlaylist ? 'Video Details / Category' : 'Episode Details / Re-tag Synopsis'}">
              <span class="material-symbols-outlined" style="font-size: 16px;">info</span>
            </button>
          </div>
          <p class="episode-plot">${escapeHtml(ep.plot || 'Stream this video in full high definition on Kodimi.')}</p>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="series-modal-header">
      <div class="series-backdrop-wrapper">
        <img class="series-backdrop" src="${backdrop}" alt="${escapeHtml(series.title)}" />
        <div class="series-gradient"></div>
      </div>
      <div class="series-header-content">
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap;">
          <span class="chip chip-primary">${isPlaylist ? 'Playlist' : 'Series'}</span>
          ${series.year ? `<span class="chip chip-outline">${series.year}</span>` : ''}
          ${!isPlaylist ? `<span class="chip">${seasonNumbers.length} Season${seasonNumbers.length > 1 ? 's' : ''}</span>` : ''}
          <span class="chip">${totalItems} ${isPlaylist ? (totalItems === 1 ? 'Video' : 'Videos') : (totalItems === 1 ? 'Episode' : 'Episodes')}</span>
          ${isPlaylist ? `<span class="chip chip-outline">Autoplay Enabled</span>` : ''}
        </div>
        <h1 class="series-title">${escapeHtml(series.title || series.series_name)}</h1>
        <p class="series-plot">${escapeHtml(series.series_plot || series.plot || (isPlaylist ? 'Watch all playlist videos continuously with autoplay.' : 'Browse all seasons and episodes below.'))}</p>
        <div class="series-actions">
          ${episodes[0] ? `
            <button class="btn-filled episode-play-btn" data-id="${episodes[0].id}">
              <span class="material-symbols-outlined fill">play_arrow</span>
              <span>${isPlaylist ? 'Play Playlist' : `Play S${activeSeason} E01`}</span>
            </button>
          ` : ''}
          ${isOwner && !isPlaylist ? `
            <button type="button" class="btn-tonal" id="series-retag-btn" data-series-name="${escapeHtml(canonicalSeriesName)}" title="Re-enrich series & episode synopses with Gemini Search Grounding">
              <span class="material-symbols-outlined">auto_awesome</span>
              <span>Re-tag Series</span>
            </button>
            <button type="button" class="btn-tonal" id="series-fix-match-toggle-btn" title="Specify exact show title, year, or network to fix synopses">
              <span class="material-symbols-outlined">edit_note</span>
              <span>Fix Match</span>
            </button>
          ` : ''}
        </div>
        ${isOwner && !isPlaylist ? `
          <div id="series-fix-match-row" class="fix-match-bar" style="display: none; margin-top: 12px; max-width: 680px;">
            <input
              type="text"
              id="series-fix-match-input"
              class="fix-match-input"
              placeholder="Exact show hint (e.g. &quot;MobLand (2025 Paramount+)&quot; or &quot;Dark Matter (2024 Apple TV+)&quot;)"
            />
            <button type="button" class="btn-filled" id="series-fix-match-apply-btn" data-series-name="${escapeHtml(canonicalSeriesName)}" style="padding: 8px 16px; font-size: 13px; white-space: nowrap;">
              <span class="material-symbols-outlined" style="font-size: 16px;">travel_explore</span>
              <span>Match &amp; Re-tag All</span>
            </button>
          </div>
        ` : ''}
        ${isOwner ? `
          <div class="series-organize-panel">
            <div class="series-organize-row">
              <span class="series-organize-label">Move category:</span>
              <div class="series-category-pills">
                <button type="button" class="filter-chip series-category-chip ${activeSeriesCat === 'series' ? 'active' : ''}" data-series-name="${escapeHtml(canonicalSeriesName)}" data-category="series">TV Series</button>
                <button type="button" class="filter-chip series-category-chip ${activeSeriesCat === 'documentary' ? 'active' : ''}" data-series-name="${escapeHtml(canonicalSeriesName)}" data-category="documentary">Documentary</button>
                <button type="button" class="filter-chip series-category-chip ${activeSeriesCat === 'others' ? 'active' : ''}" data-series-name="${escapeHtml(canonicalSeriesName)}" data-category="others">Others</button>
              </div>
            </div>
            <div class="series-organize-chips">
              ${seriesGenresHtml}
              ${seriesTagsHtml}
            </div>
            <form id="series-tag-editor-form" class="tag-editor-row" data-series-name="${escapeHtml(canonicalSeriesName)}">
              <select id="series-tag-kind-select" class="tag-editor-select" aria-label="Tag type">
                <option value="tag">Tag</option>
                <option value="genre">Genre</option>
              </select>
              <input
                type="text"
                id="series-tag-input"
                class="tag-editor-input"
                placeholder="Add tag or genre to all items (comma-separated)"
                aria-label="Add tag or genre to collection"
              />
              <button type="submit" class="btn-tonal" style="padding: 6px 12px; font-size: 12px;">Add</button>
            </form>
          </div>
        ` : (seriesGenresHtml || seriesTagsHtml ? `<div class="series-organize-chips" style="margin-top: 12px;">${seriesGenresHtml}${seriesTagsHtml}</div>` : '')}
      </div>
    </div>

    <div class="series-seasons-section">
      <div class="season-tabs-container">
        ${seasonTabsHtml}
      </div>
      <div class="episodes-list">
        ${episodesHtml}
      </div>
    </div>
  `;
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

export function renderProfileCard(profile, isManaging = false, hasPendingReset = false) {
  const color = profile.color || '#e50914';
  const icon = profile.avatar || 'account_circle';
  const isOwner = profile.role === 'owner' || profile.id === 'default';
  const needsCode = profile.has_passcode === false;
  return `
    <div class="profile-card" data-profile-id="${escapeHtml(profile.id)}">
      <div class="profile-card-avatar" style="background-color: ${color};">
        <span class="material-symbols-outlined" aria-hidden="true" style="font-size: 52px; color: white;">${icon}</span>
        ${profile.is_kids ? '<span class="profile-card-badge">Kids</span>' : isOwner ? '<span class="profile-card-badge" style="background:#e50914;color:white;">Owner</span>' : ''}
        ${isManaging ? '<div class="profile-card-edit-overlay"><span class="material-symbols-outlined" aria-hidden="true" style="font-size: 32px;">edit</span></div>' : ''}
      </div>
      <span class="profile-card-name">${escapeHtml(profile.name)}</span>
      ${hasPendingReset ? '<span class="profile-reset-pill">Reset requested</span>' : ''}
      ${needsCode ? '<span style="font-size: 11px; color: #ffb74d; margin-top: 2px; font-weight: 600;">No login code set</span>' : '<span style="font-size: 11px; color: #81c784; margin-top: 2px;">Code protected</span>'}
    </div>
  `;
}

export function formatRelativeTime(isoOrDate) {
  if (!isoOrDate) return 'Just now';
  const ts = new Date(isoOrDate).getTime();
  if (!Number.isFinite(ts)) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

export function renderResetRequestCard(reqItem, profiles = []) {
  const safeId = escapeHtml(reqItem.id);
  const safeRequestedName = escapeHtml(reqItem.requested_name || 'Unknown');
  const matched = reqItem.matched_profile || null;
  const matchedId = matched?.id || reqItem.matched_profile_id || '';
  const attemptsCount = Number(reqItem.failed_attempts || 5);
  const whenText = formatRelativeTime(reqItem.created_at);

  const profileOptionsHtml = [
    `<option value="">Select profile to reset</option>`,
    ...profiles.map((p) => {
      const selected = p.id === matchedId ? 'selected' : '';
      const roleTag = p.role === 'owner' || p.id === 'default' ? ' (Owner)' : p.is_kids ? ' (Kids)' : '';
      return `<option value="${escapeHtml(p.id)}" ${selected}>${escapeHtml(p.name)}${roleTag}</option>`;
    }),
  ].join('');

  return `
    <article class="reset-request-card" data-request-id="${safeId}">
      <div class="reset-request-card-header">
        <div class="reset-request-identity">
          <div class="reset-request-name-row">
            <h2 class="reset-request-name">${safeRequestedName}</h2>
            ${
              matched
                ? `<span class="reset-match-pill matched">Matched: ${escapeHtml(matched.name)}</span>`
                : `<span class="reset-match-pill unmatched">No exact match</span>`
            }
          </div>
          <p class="reset-request-meta">
            <span class="tabular-nums">${attemptsCount} failed attempts</span> • <span>${escapeHtml(whenText)}</span>
          </p>
        </div>
      </div>

      <form class="reset-request-form" data-request-id="${safeId}">
        <div class="reset-form-field">
          <label for="reset-profile-select-${safeId}">Profile to reset</label>
          <select id="reset-profile-select-${safeId}" name="profileId" class="reset-form-control" required>
            ${profileOptionsHtml}
          </select>
        </div>

        <div class="reset-form-field">
          <label for="reset-new-code-${safeId}">New unique login code</label>
          <div class="reset-code-input-row">
            <input
              type="text"
              id="reset-new-code-${safeId}"
              name="newPasscode"
              class="reset-form-control reset-code-input"
              minlength="4"
              maxlength="72"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="Leave blank to auto-generate"
            />
            <button
              type="button"
              class="btn-tonal reset-generate-btn"
              data-target-input="reset-new-code-${safeId}"
              aria-label="Generate unique code for ${safeRequestedName}"
            >
              <span class="material-symbols-outlined" aria-hidden="true">casino</span>
              <span>Generate</span>
            </button>
          </div>
        </div>

        <div class="reset-request-error" role="alert" hidden></div>

        <div class="reset-request-actions">
          <button type="submit" class="btn-filled reset-submit-btn">
            <span class="material-symbols-outlined" aria-hidden="true">lock_reset</span>
            <span>Reset code &amp; unlock</span>
          </button>
          <button type="button" class="btn-tonal reset-unlock-only-btn" data-request-id="${safeId}">
            <span>Unlock only</span>
          </button>
          <button type="button" class="btn-tonal reset-dismiss-btn" data-request-id="${safeId}">
            <span>Dismiss</span>
          </button>
        </div>
      </form>
    </article>
  `;
}

export function renderAddProfileCard() {
  return `
    <div class="profile-card" id="profile-card-add" style="opacity: 0.85;">
      <div class="profile-card-avatar" style="background-color: var(--md-sys-color-surface-container-high); border: 2px dashed var(--md-sys-color-outline);">
        <span class="material-symbols-outlined" style="font-size: 44px; color: var(--md-sys-color-outline);">add</span>
      </div>
      <span class="profile-card-name" style="color: var(--md-sys-color-outline);">Add Profile</span>
    </div>
  `;
}

export function renderProfileDropdownItem(profile, isActive = false) {
  const color = profile.color || '#e50914';
  const icon = profile.avatar || 'account_circle';
  return `
    <button class="profile-dropdown-item ${isActive ? 'active' : ''}" data-profile-id="${profile.id}">
      <div style="width: 24px; height: 24px; border-radius: 50%; background-color: ${color}; display: flex; align-items: center; justify-content: center;">
        <span class="material-symbols-outlined" style="font-size: 14px; color: white;">${icon}</span>
      </div>
      <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(profile.name)}</span>
      ${profile.is_kids ? '<span style="font-size: 9px; background: #ff9500; color: black; padding: 1px 4px; border-radius: 4px; font-weight: 700;">KIDS</span>' : ''}
      ${isActive ? '<span class="material-symbols-outlined" style="font-size: 16px; margin-left: auto;">check</span>' : ''}
    </button>
  `;
}

