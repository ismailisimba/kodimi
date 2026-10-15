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
      <img class="card-poster" src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="if(this.src.indexOf('/thumbnail') === -1) { this.src='${thumbUrl}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=${encodeURIComponent(item.title.slice(0, 16))}'; }" />
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

  const speedStr = formatSpeed(dl.speed);
  const sizeStr = dl.total_bytes > 0
    ? `${formatBytes(dl.downloaded_bytes)} / ${formatBytes(dl.total_bytes)}`
    : '';

  let actionButtonsHtml = '';
  if (isDownloading) {
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
  } else {
    actionButtonsHtml = `
      <button class="icon-btn dl-delete-btn" data-id="${dl.id}" title="Delete from list" style="width: 28px; height: 28px; color: #ffb4ab;">
        <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
      </button>
    `;
  }

  const statusDisplay = dl.status_text
    ? escapeHtml(dl.status_text)
    : isCompleted
    ? '<span style="color: #4caf50;">✓ Saved to GCS</span>'
    : isDownloading
    ? '<span style="color: var(--md-sys-color-primary);">Streaming to GCS...</span>'
    : isPaused
    ? '<span style="color: #ffb74d;">⏸ Paused</span>'
    : isFailed
    ? `<span style="color: #f44336;">${escapeHtml(dl.error || 'Failed')}</span>`
    : '';

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
        <div style="height: 100%; width: ${dl.progress || 0}%; background-color: ${isCompleted ? '#4caf50' : isFailed ? '#f44336' : isPaused ? '#ffb74d' : 'var(--md-sys-color-primary)'}; transition: width 0.3s ease;"></div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--md-sys-color-on-surface-variant);">
        <div style="display: flex; gap: 12px;">
          <span>${Math.round(dl.progress || 0)}%</span>
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderSeriesCard(series) {
  const pin = sessionStorage.getItem('kodimi_vault_pin');
  const pinParam = (series.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const fallbackThumb = series.sample_media_id ? `/api/media/${series.sample_media_id}/thumbnail?variant=69${pinParam}` : '';
  let poster = series.poster_url || fallbackThumb;
  if (!poster || poster.includes('placehold.co') || series.is_adult) {
    poster = fallbackThumb;
  }

  const seasonText = `${series.seasons_count || 1} Season${(series.seasons_count || 1) > 1 ? 's' : ''}`;
  const epText = `${series.episodes_count || 1} Ep${(series.episodes_count || 1) > 1 ? 's' : ''}`;

  return `
    <div class="media-card series-card" data-series-name="${escapeHtml(series.series_name || series.title)}" data-sample-id="${series.sample_media_id || ''}">
      <img class="card-poster" src="${poster}" alt="${escapeHtml(series.title)}" loading="lazy" onerror="if(this.src.indexOf('/thumbnail') === -1 && '${fallbackThumb}') { this.src='${fallbackThumb}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=${encodeURIComponent(series.title.slice(0, 16))}'; }" />
      <span class="card-badge" style="background-color: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); font-weight: 700;">${seasonText} • ${epText}</span>
      <div class="card-overlay">
        <div class="card-title">${escapeHtml(series.title)}</div>
        <div class="card-meta">
          ${series.year ? `<span>${series.year}</span>` : ''}
          ${series.genres && series.genres[0] ? `<span>• ${series.genres[0]}</span>` : ''}
        </div>
        <div class="card-quick-actions">
          <button class="quick-play-btn series-browse-btn" data-series-name="${escapeHtml(series.series_name || series.title)}" title="Browse Seasons & Episodes">
            <span class="material-symbols-outlined fill" style="font-size: 18px;">video_library</span>
          </button>
          <button class="quick-info-btn series-info-btn" data-series-name="${escapeHtml(series.series_name || series.title)}" title="Series Info">
            <span class="material-symbols-outlined" style="font-size: 18px;">info</span>
          </button>
        </div>
      </div>
    </div>
  `;
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

  return `
    <div class="live-channel-card" data-channel-id="${ch.id}" data-stream-url="${escapeHtml(ch.streamUrl)}" data-name="${escapeHtml(ch.name)}">
      <div class="live-card-header">
        <div class="live-channel-info">
          <img class="live-channel-logo" src="${escapeHtml(ch.logo)}" alt="${escapeHtml(ch.name)}" onerror="this.src='https://placehold.co/80x80/1e1e1e/white?text=${encodeURIComponent(ch.name.slice(0,3))}';" />
          <div>
            <div class="live-channel-name">${escapeHtml(ch.name)}</div>
            <div class="live-channel-meta">
              <span class="live-badge">🔴 LIVE</span>
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

export function renderSeriesModalContent(seriesData, activeSeason = 1) {
  const series = seriesData.series || {};
  const seasonsMap = seriesData.seasons || {};
  const seasonNumbers = seriesData.seasonNumbers || [1];

  const pin = sessionStorage.getItem('kodimi_vault_pin');
  const pinParam = (series.is_adult && pin) ? `&pin=${encodeURIComponent(pin)}` : '';
  const fallbackThumb = series.sample_media_id ? `/api/media/${series.sample_media_id}/thumbnail?variant=69${pinParam}` : '';
  let backdrop = series.backdrop_url || series.poster_url || fallbackThumb;
  if (!backdrop || backdrop.includes('placehold.co')) {
    backdrop = fallbackThumb;
  }

  // Season Tabs HTML
  const seasonTabsHtml = seasonNumbers.map((sNum) => `
    <button class="season-tab-btn ${sNum === activeSeason ? 'active' : ''}" data-season="${sNum}">
      Season ${sNum} <span style="font-size: 11px; opacity: 0.8;">(${seasonsMap[sNum]?.length || 0})</span>
    </button>
  `).join('');

  // Active Season Episodes HTML
  const episodes = seasonsMap[activeSeason] || [];
  const episodesHtml = episodes.map((ep) => {
    const epThumb = `/api/media/${ep.id}/thumbnail?variant=42${pinParam}`;
    const startTime = ep.current_time || 0;
    const isResume = startTime > 10;
    const durStr = ep.duration > 0 ? `${Math.round(ep.duration / 60)}m` : 'HD';

    return `
      <div class="series-episode-card" data-id="${ep.id}">
        <div class="episode-thumb-container">
          <img class="episode-thumb" src="${epThumb}" alt="${escapeHtml(ep.title)}" onerror="if(this.src.indexOf('/thumbnail') === -1 && '${fallbackThumb}') { this.src='${fallbackThumb}'; } else { this.src='https://placehold.co/640x360/1e1e1e/white?text=E${ep.episode || 1}'; }" />
          <button class="episode-play-overlay episode-play-btn" data-id="${ep.id}" data-time="${startTime}" title="${isResume ? 'Resume' : 'Play'}">
            <span class="material-symbols-outlined fill" style="font-size: 28px;">play_arrow</span>
          </button>
          <span class="episode-badge">E${String(ep.episode || 1).padStart(2, '0')}</span>
          ${ep.current_time && ep.playback_duration ? `
            <div class="episode-progress-bar">
              <div class="episode-progress-fill" style="width: ${Math.min(100, (ep.current_time / ep.playback_duration) * 100)}%;"></div>
            </div>
          ` : ''}
        </div>
        <div class="episode-info">
          <div class="episode-title-row">
            <span class="episode-number">Episode ${ep.episode || 1}</span>
            <span class="episode-title">${escapeHtml(ep.title.replace(/^.*?[sS]\d+[eE]\d+:?\s*/, ''))}</span>
            <span class="episode-dur">${durStr}</span>
          </div>
          <p class="episode-plot">${escapeHtml(ep.plot || 'Stream this episode in full high definition on Kodimi.')}</p>
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
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
          <span class="chip chip-primary">Series</span>
          ${series.year ? `<span class="chip chip-outline">${series.year}</span>` : ''}
          <span class="chip">${seasonNumbers.length} Season${seasonNumbers.length > 1 ? 's' : ''}</span>
          <span class="chip">${Object.values(seasonsMap).flat().length} Episodes</span>
        </div>
        <h1 class="series-title">${escapeHtml(series.title || series.series_name)}</h1>
        <p class="series-plot">${escapeHtml(series.plot || 'Browse all seasons and episodes below.')}</p>
        <div class="series-actions">
          ${episodes[0] ? `
            <button class="btn-filled episode-play-btn" data-id="${episodes[0].id}">
              <span class="material-symbols-outlined fill">play_arrow</span>
              <span>Play S${activeSeason} E01</span>
            </button>
          ` : ''}
        </div>
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

