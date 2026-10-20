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
};

export async function request(endpoint, options = {}) {
  const token = authState.getToken();
  const vaultPin = vaultState.getPin();
  const activeProfileId = profileState.getActiveProfileId();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (vaultPin) {
    headers['x-vault-pin'] = vaultPin;
  }
  if (activeProfileId) {
    headers['x-profile-id'] = activeProfileId;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    authState.clearToken();
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
  // Auth
  login: async (password) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Invalid password');
    }
    const data = await res.json();
    authState.setToken(data.token);
    return data;
  },

  checkAuth: () => request('/auth/me'),

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

  retagMedia: (id) => request(`/media/${id}/retag`, { method: 'POST' }),

  deleteMedia: (id) => request(`/media/${id}`, { method: 'DELETE' }),

  // Bucket Sync
  syncBucket: () => request('/media/sync-bucket', { method: 'POST' }),

  getSyncStatus: () => request('/media/sync-status'),

  // Downloads
  getDownloads: () => request('/downloads'),

  startDownload: (url, name = '') =>
    request('/downloads', {
      method: 'POST',
      body: JSON.stringify({ url, name }),
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

  requestUploadUrl: (filename, size, contentType = 'application/octet-stream') =>
    request('/downloads/request-upload', {
      method: 'POST',
      body: JSON.stringify({ filename, size, contentType }),
    }),

  completeUpload: (filename, size, downloadId) =>
    request('/downloads/complete-upload', {
      method: 'POST',
      body: JSON.stringify({ filename, size, downloadId }),
    }),

  uploadTorrentFile: (filename, base64Data) =>
    request('/downloads/upload-torrent', {
      method: 'POST',
      body: JSON.stringify({ filename, data: base64Data }),
    }),

  // Playback Progress
  saveProgress: (mediaId, currentTime, duration, completed = 0) =>
    request('/media/playback/progress', {
      method: 'POST',
      body: JSON.stringify({ mediaId, currentTime, duration, completed }),
    }),

  // Stream URL Generator with auth token & vault pin
  getStreamUrl: (id, quality = 'original', time = 0) => {
    const token = authState.getToken();
    const pin = vaultState.getPin();
    const pinParam = pin ? `&pin=${encodeURIComponent(pin)}` : '';
    if (quality === 'direct') {
      return `${API_BASE}/stream/${id}?direct=true&time=${time}&token=${token}${pinParam}`;
    }
    if (quality === 'original') {
      return `${API_BASE}/stream/${id}?time=${time}&token=${token}${pinParam}`;
    }
    return `${API_BASE}/stream/${id}/transcode?quality=${quality}&time=${time}&token=${token}${pinParam}`;
  },

  // Subtitle URL Generator
  getSubtitleUrl: (id, track = 0) => {
    const token = authState.getToken();
    const pin = vaultState.getPin();
    const pinParam = pin ? `&pin=${encodeURIComponent(pin)}` : '';
    return `${API_BASE}/stream/${id}/subtitles?track=${track}&token=${token}${pinParam}`;
  },

  // Series & Seasons
  getSeries: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/media/series${query ? `?${query}` : ''}`);
  },

  getSeriesSeasons: (name, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/media/series/${encodeURIComponent(name)}/seasons${query ? `?${query}` : ''}`);
  },

  // Live TV & EPG
  getLiveCategories: () => request('/iptv/categories'),

  getLiveChannels: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/iptv/channels${query ? `?${query}` : ''}`);
  },

  getChannelSchedule: (id) => request(`/iptv/channels/${encodeURIComponent(id)}/schedule`),

  getLiveProxyUrl: (streamUrl) => `${API_BASE}/iptv/proxy?url=${encodeURIComponent(streamUrl)}`,

  getLiveTranscodeUrl: (streamUrl, quality = '480p') =>
    `${API_BASE}/iptv/transcode?url=${encodeURIComponent(streamUrl)}&quality=${quality}`,

  // Subtitle Tracks Probe
  getSubtitleTracks: (id) => request(`/stream/${id}/subtitles/tracks`),

  // Profiles & Watchlist
  getProfiles: () => request('/profiles'),
  createProfile: (data) => request('/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateProfile: (id, data) => request(`/profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProfile: (id) => request(`/profiles/${id}`, { method: 'DELETE' }),
  getWatchlist: (profileId) => request(`/profiles/${profileId || profileState.getActiveProfileId()}/watchlist`),
  toggleWatchlist: (mediaId, profileId) =>
    request(`/profiles/${profileId || profileState.getActiveProfileId()}/watchlist/${mediaId}`, { method: 'POST' }),
};

export default api;
