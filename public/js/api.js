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
  if (vaultPin) {
    headers['x-vault-pin'] = vaultPin;
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

  // Subtitle Tracks Probe
  getSubtitleTracks: (id) => request(`/stream/${id}/subtitles/tracks`),
};

export default api;
