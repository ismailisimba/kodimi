/**
 * Kodimi API Client Module
 */
const API_BASE = '/api';

export const authState = {
  getToken: () => localStorage.getItem('kodimi_token'),
  setToken: (token) => localStorage.setItem('kodimi_token', token),
  clearToken: () => localStorage.removeItem('kodimi_token'),
  isAuthenticated: () => Boolean(localStorage.getItem('kodimi_token')),
};

export const vaultState = {
  getPin: () => sessionStorage.getItem('kodimi_vault_pin'),
  setPin: (pin) => sessionStorage.setItem('kodimi_vault_pin', pin),
  isUnlocked: () => Boolean(sessionStorage.getItem('kodimi_vault_pin')),
  lock: () => sessionStorage.removeItem('kodimi_vault_pin'),
};

export const profileState = {
  getActiveProfile: () => {
    try {
      const p = localStorage.getItem('kodimi_active_profile');
      return p ? JSON.parse(p) : null;
    } catch {
      return null;
    }
  },
  setActiveProfile: (profile) => {
    if (!profile) {
      localStorage.removeItem('kodimi_active_profile');
    } else {
      localStorage.setItem('kodimi_active_profile', JSON.stringify(profile));
    }
    window.dispatchEvent(new CustomEvent('kodimi_profile_changed', { detail: profile }));
  },
  getActiveProfileId: () => {
    const p = profileState.getActiveProfile();
    return p?.id || 'default';
  },
  isOwner: () => {
    const p = profileState.getActiveProfile();
    return Boolean(p && p.role === 'owner' && !p.is_kids);
  },
};

export async function request(endpoint, options = {}) {
  const token = authState.getToken();
  const vaultPin = vaultState.getPin();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (vaultPin && profileState.isOwner()) {
    headers['x-vault-pin'] = vaultPin;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    authState.clearToken();
    vaultState.lock();
    profileState.setActiveProfile(null);
    window.dispatchEvent(new CustomEvent('kodimi_auth_required'));
    throw new Error('Authentication required');
  }

  if (res.status === 403) {
    const errorData = await res.json().catch(() => ({}));
    if (errorData.vaultRequired) {
      vaultState.lock();
    }
    throw new Error(errorData.error || 'Access forbidden');
  }

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}

export const api = {
  // Auth (Code-only per-profile login + 5-attempt lockout)
  getLockoutStatus: async () => {
    const res = await fetch(`${API_BASE}/auth/lockout-status`);
    if (!res.ok) {
      return { locked: false, failedAttempts: 0, maxAttempts: 5, attemptsRemaining: 5, requestSent: false };
    }
    return res.json();
  },

  login: async (code) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(errBody.error || 'Incorrect login code');
      err.status = res.status;
      err.locked = Boolean(errBody.locked || res.status === 423);
      err.failedAttempts = errBody.failedAttempts;
      err.maxAttempts = errBody.maxAttempts;
      err.attemptsRemaining = errBody.attemptsRemaining;
      err.requestSent = Boolean(errBody.requestSent);
      err.canRequestReset = errBody.canRequestReset;
      err.expiresAt = errBody.expiresAt || null;
      throw err;
    }
    const data = await res.json();
    authState.setToken(data.token);
    vaultState.lock();
    if (data.profile) {
      profileState.setActiveProfile(data.profile);
    }
    return data;
  },

  requestProfileReset: async (profileName) => {
    const res = await fetch(`${API_BASE}/auth/request-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Could not send reset request');
      err.status = res.status;
      throw err;
    }
    return data;
  },

  checkAuth: async () => {
    const data = await request('/auth/me');
    if (data?.profile) {
      profileState.setActiveProfile(data.profile);
    }
    return data;
  },

  changeCode: async (currentCode, newCode) => {
    const data = await request('/auth/change-code', {
      method: 'POST',
      body: JSON.stringify({ currentCode, newCode }),
    });
    if (data?.token) {
      authState.setToken(data.token);
    }
    return data;
  },

  verifyPin: (pin) =>
    request('/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),

  // Media
  getMedia: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/media${query ? `?${query}` : ''}`);
  },

  getMediaById: (id) => request(`/media/${id}`),

  getMediaDuration: (id) => request(`/media/${id}/duration`),

  getGenres: () => request('/media/genres'),

  getContinueWatching: () => request('/media/continue-watching'),

  retagMedia: (id, matchHint = '') =>
    request(`/media/${id}/retag`, {
      method: 'POST',
      body: JSON.stringify(matchHint ? { matchHint } : {}),
    }),

  retagSeries: (name, matchHint = '') =>
    request(`/media/series/${encodeURIComponent(name)}/retag`, {
      method: 'POST',
      body: JSON.stringify(matchHint ? { matchHint } : {}),
    }),

  updateMediaCategory: (id, category) =>
    request(`/media/${id}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category }),
    }),

  updateMediaTags: (id, payload = {}) =>
    request(`/media/${id}/tags`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  updateSeriesCategory: (seriesName, category, adult = false) =>
    request(`/media/series/${encodeURIComponent(seriesName)}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category, ...(adult ? { adult: true } : {}) }),
    }),

  updateSeriesTags: (seriesName, payload = {}, adult = false) =>
    request(`/media/series/${encodeURIComponent(seriesName)}/tags`, {
      method: 'PATCH',
      body: JSON.stringify({ ...payload, ...(adult ? { adult: true } : {}) }),
    }),

  retagInaccurate: (options = {}) =>
    request('/media/retag-inaccurate', {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  getRetagStatus: () => request('/media/retag-status'),

  deleteMedia: (id) => request(`/media/${id}`, { method: 'DELETE' }),

  // Bucket Sync (Owner-only)
  syncBucket: () => request('/media/sync-bucket', { method: 'POST' }),

  getSyncStatus: () => request('/media/sync-status'),

  // Downloads & Social Media Ingestion (Owner-only)
  getDownloads: () => request('/downloads'),

  startDownload: (url, name = '', category = '', options = {}) =>
    request('/downloads', {
      method: 'POST',
      body: JSON.stringify({
        url,
        name,
        ...(category ? { category } : {}),
        ...(typeof options.playlist === 'boolean' ? { playlist: options.playlist } : {}),
        ...(options.maxItems ? { maxItems: Number(options.maxItems) } : {}),
      }),
    }),

  cancelDownload: (id) => request(`/downloads/${id}`, { method: 'DELETE' }),
  deleteDownload: (id) => request(`/downloads/${id}`, { method: 'DELETE' }),
  pauseDownload: (id) => request(`/downloads/${id}/pause`, { method: 'POST' }),
  resumeDownload: (id) => request(`/downloads/${id}/resume`, { method: 'POST' }),
  toggleVault: (id, isAdult) =>
    request(`/media/${id}/vault-toggle`, {
      method: 'POST',
      body: JSON.stringify({ is_adult: isAdult }),
    }),

  requestUploadUrl: (filename, size, contentType = 'application/octet-stream', category = '') =>
    request('/downloads/request-upload', {
      method: 'POST',
      body: JSON.stringify({ filename, size, contentType, ...(category ? { category } : {}) }),
    }),

  completeUpload: (filename, size, downloadId, category = '') =>
    request('/downloads/complete-upload', {
      method: 'POST',
      body: JSON.stringify({ filename, size, downloadId, ...(category ? { category } : {}) }),
    }),

  uploadTorrentFile: (filename, base64Data, category = '') =>
    request('/downloads/upload-torrent', {
      method: 'POST',
      body: JSON.stringify({ filename, data: base64Data, ...(category ? { category } : {}) }),
    }),

  // Playback Progress
  saveProgress: (mediaId, currentTime, duration, completed = 0, options = {}) =>
    request('/media/playback/progress', {
      method: 'POST',
      keepalive: Boolean(options.keepalive),
      body: JSON.stringify({ mediaId, currentTime, duration, completed }),
    }),

  dismissContinueWatching: (mediaId) =>
    request(`/media/playback/${encodeURIComponent(mediaId)}`, {
      method: 'DELETE',
    }),

  // Stream URL Generator with auth token, vault pin, codec negotiation & session ID
  getStreamUrl: (id, quality = 'original', time = 0, opts = {}) => {
    const token = authState.getToken();
    const pin = profileState.isOwner() ? vaultState.getPin() : null;
    const pinParam = pin ? `&pin=${encodeURIComponent(pin)}` : '';
    const sidParam = opts.sid ? `&sid=${encodeURIComponent(opts.sid)}` : '';
    const codecParam = opts.codec ? `&codec=${encodeURIComponent(opts.codec)}` : '';
    const capParam = `${opts.av1 ? '&av1=1' : ''}${opts.hevc ? '&hevc=1' : ''}`;
    const roundedTime = Math.max(0, Number(time || 0)).toFixed(2);

    if (quality === 'direct') {
      return `${API_BASE}/stream/${id}?direct=true&time=${roundedTime}&token=${encodeURIComponent(token || '')}${pinParam}${sidParam}`;
    }
    if (quality === 'original') {
      return `${API_BASE}/stream/${id}?time=${roundedTime}&token=${encodeURIComponent(token || '')}${pinParam}${sidParam}`;
    }
    return `${API_BASE}/stream/${id}/transcode?quality=${encodeURIComponent(quality)}&time=${roundedTime}${codecParam}${capParam}${sidParam}&token=${encodeURIComponent(token || '')}${pinParam}`;
  },

  // Subtitle URL Generator
  getSubtitleUrl: (id, trackOrOptions = 0) => {
    const token = authState.getToken();
    const pin = profileState.isOwner() ? vaultState.getPin() : null;
    const pinParam = pin ? `&pin=${encodeURIComponent(pin)}` : '';
    if (trackOrOptions && typeof trackOrOptions === 'object' && trackOrOptions.customId) {
      return `${API_BASE}/stream/${id}/subtitles?customId=${encodeURIComponent(trackOrOptions.customId)}&v=2&token=${encodeURIComponent(token || '')}${pinParam}`;
    }
    const trackIdx = typeof trackOrOptions === 'object' ? (trackOrOptions.trackIndex ?? 0) : trackOrOptions;
    return `${API_BASE}/stream/${id}/subtitles?track=${trackIdx}&v=2&token=${encodeURIComponent(token || '')}${pinParam}`;
  },

  uploadCustomSubtitle: (id, { filename, label, language, content }) =>
    request(`/stream/${id}/subtitles/custom`, {
      method: 'POST',
      body: JSON.stringify({ filename, label, language, content }),
    }),

  deleteCustomSubtitle: (id, subId) =>
    request(`/stream/${id}/subtitles/custom/${encodeURIComponent(subId)}`, {
      method: 'DELETE',
    }),

  // Series & Seasons
  getSeries: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/media/series${query ? `?${query}` : ''}`);
  },

  getSeriesSeasons: (name, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/media/series/${encodeURIComponent(name)}/seasons${query ? `?${query}` : ''}`);
  },

  // Live TV & EPG (Authenticated Proxy & Transcode)
  getLiveCategories: () => request('/iptv/categories'),

  getLiveChannels: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/iptv/channels${query ? `?${query}` : ''}`);
  },

  getChannelSchedule: (id) => request(`/iptv/channels/${encodeURIComponent(id)}/schedule`),

  reportLiveChannelOffline: (id, reason = '') =>
    request(`/iptv/channels/${encodeURIComponent(id)}/report-offline`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  getLiveProxyUrl: (streamUrl, channelId = '') => {
    const token = authState.getToken() || '';
    const chParam = channelId ? `&channelId=${encodeURIComponent(channelId)}` : '';
    return `${API_BASE}/iptv/proxy?url=${encodeURIComponent(streamUrl)}${chParam}&token=${encodeURIComponent(token)}`;
  },

  getLiveTranscodeUrl: (streamUrl, quality = '480p', channelId = '') => {
    const token = authState.getToken() || '';
    const chParam = channelId ? `&channelId=${encodeURIComponent(channelId)}` : '';
    return `${API_BASE}/iptv/transcode?url=${encodeURIComponent(streamUrl)}&quality=${encodeURIComponent(quality)}${chParam}&token=${encodeURIComponent(token)}`;
  },

  // Subtitle Tracks Probe
  getSubtitleTracks: (id) => request(`/stream/${id}/subtitles/tracks`),

  // Profiles (Owner CRUD), Reset Requests (Owner Inbox) & Watchlist (Self-isolated)
  getProfiles: () => request('/profiles'),
  generateProfileCode: () => request('/profiles/generate-code', { method: 'POST' }),
  getResetRequests: () => request('/profiles/reset-requests'),
  resolveResetRequest: async (requestId, payload = {}) => {
    const data = await request(`/profiles/reset-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (data?.token) {
      authState.setToken(data.token);
    }
    return data;
  },
  createProfile: (data) => request('/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateProfile: async (id, data) => {
    const res = await request(`/profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    if (res?.token) {
      authState.setToken(res.token);
    }
    return res;
  },
  deleteProfile: (id) => request(`/profiles/${id}`, { method: 'DELETE' }),
  getWatchlist: (profileId) => request(`/profiles/${profileId || profileState.getActiveProfileId()}/watchlist`),
  toggleWatchlist: (mediaId, profileId) =>
    request(`/profiles/${profileId || profileState.getActiveProfileId()}/watchlist/${mediaId}`, { method: 'POST' }),
};

export default api;
