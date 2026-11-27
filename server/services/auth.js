import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import {
  profilesDB,
  sanitizeProfile,
  computePasscodeFingerprint,
  normalizePasscode,
  normalizeClientKey,
  MAX_PASSCODE_BYTES,
} from '../db/database.js';

export function getClientIp(req) {
  const raw =
    (req?.headers?.['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null) ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    'unknown';
  return normalizeClientKey(raw);
}

function timingSafeHexEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function verifyPassword(inputPassword) {
  if (!inputPassword) return false;
  const candidate = normalizePasscode(inputPassword);
  const adminRaw = normalizePasscode(config.adminPassword);
  // Support both plain text match or bcrypt hashed comparison
  if (candidate === adminRaw) return true;
  try {
    return bcrypt.compareSync(candidate, config.adminPassword);
  } catch {
    return false;
  }
}

export function hashPasscode(plainCode) {
  return bcrypt.hashSync(normalizePasscode(plainCode), 10);
}

export function verifyPasscodeHash(inputCode, hash) {
  if (!inputCode || !hash) return false;
  const normalized = normalizePasscode(inputCode);
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_PASSCODE_BYTES) return false;
  try {
    return bcrypt.compareSync(normalized, hash);
  } catch {
    return false;
  }
}

/**
 * Authenticates a user solely by their unique profile login code (zero pre-auth profile enumeration).
 * Uses O(1) keyed HMAC fingerprint lookup first (with bcrypt verification), falling back to bcrypt
 * only for legacy unmigrated profiles without a stored fingerprint.
 * Returns the matched raw profile or null if invalid.
 */
export function authenticateByCode(inputCode) {
  if (!inputCode || typeof inputCode !== 'string') return null;
  const trimmed = normalizePasscode(inputCode);
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_PASSCODE_BYTES) return null;

  const allProfiles = profilesDB.getAllRaw();
  const candidateFp = computePasscodeFingerprint(trimmed);

  // 1. Fast constant-time fingerprint lookup + bcrypt verification
  if (candidateFp) {
    for (const profile of allProfiles) {
      if (profile.passcode_fingerprint && timingSafeHexEqual(profile.passcode_fingerprint, candidateFp)) {
        if (profile.passcode_hash && verifyPasscodeHash(trimmed, profile.passcode_hash)) {
          return {
            ...profile,
            role: profile.role || (profile.id === 'default' ? 'owner' : 'member'),
          };
        }
      }
    }
  }

  // 2. Legacy fallback ONLY for profiles that haven't had a fingerprint backfilled yet
  for (const profile of allProfiles) {
    if (!profile.passcode_fingerprint && profile.passcode_hash && verifyPasscodeHash(trimmed, profile.passcode_hash)) {
      // Lazily backfill fingerprint so future logins use the atomic O(1) path
      profilesDB.backfillPasscodeFingerprint(profile.id, trimmed).catch(() => {});
      return {
        ...profile,
        role: profile.role || (profile.id === 'default' ? 'owner' : 'member'),
      };
    }
  }

  // 3. Fallback for Owner if DB hasn't seeded passcode_hash yet (e.g. cold/unmigrated state)
  const owner = allProfiles.find((p) => p.id === 'default' || p.role === 'owner');
  if (owner && !owner.passcode_hash && verifyPassword(trimmed)) {
    return { ...owner, role: 'owner' };
  }
  if (allProfiles.length === 0 && verifyPassword(trimmed)) {
    return {
      id: 'default',
      name: 'Owner',
      avatar: 'account_circle',
      color: '#e50914',
      is_kids: false,
      role: 'owner',
      passcode_version: 0,
    };
  }

  return null;
}

export function generateToken(profileOrPayload = null, extra = {}) {
  let payload;
  if (profileOrPayload && profileOrPayload.id) {
    const role = profileOrPayload.role || (profileOrPayload.id === 'default' ? 'owner' : 'member');
    payload = {
      profileId: profileOrPayload.id,
      name: profileOrPayload.name || 'User',
      role,
      is_kids: Boolean(profileOrPayload.is_kids),
      pv: Number(profileOrPayload.passcode_version || 0),
      ...(extra.vault && role === 'owner' && !profileOrPayload.is_kids ? { vault: true } : {}),
    };
  } else if (profileOrPayload && profileOrPayload.profileId) {
    payload = { ...profileOrPayload, ...extra };
  } else {
    payload = {
      profileId: 'default',
      name: 'Owner',
      role: 'owner',
      is_kids: false,
      pv: 0,
      ...(profileOrPayload || {}),
      ...extra,
    };
  }

  return jwt.sign(payload, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export function extractTokenFromRequest(req) {
  if (req?.headers?.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req?.query && req.query.token) {
    return String(req.query.token);
  }
  return null;
}

/**
 * Express middleware to protect routes with profile-bound JWT authentication.
 * Supports token via Header (Bearer) or Query param (?token=) for video streaming/SSE/HLS.
 */
export function requireAuth(req, res, next) {
  const token = extractTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded || !decoded.profileId) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in with your login code.' });
  }

  // Reconcile against live profile registry when populated so deleted profiles or role/kids changes take effect immediately
  const allProfiles = profilesDB.getAllRaw();
  if (allProfiles.length > 0) {
    const liveProfile = profilesDB.getRawById(decoded.profileId);
    if (!liveProfile) {
      return res.status(401).json({ error: 'Profile no longer exists. Please sign in again.' });
    }
    const livePasscodeVersion = Number(liveProfile.passcode_version || 0);
    if (livePasscodeVersion > 0 && Number(decoded.pv || 0) !== livePasscodeVersion) {
      return res.status(401).json({ error: 'Your login code was updated. Please sign in with your new code.' });
    }
    const liveRole = liveProfile.role || (liveProfile.id === 'default' ? 'owner' : 'member');
    const liveKids = Boolean(liveProfile.is_kids);
    req.user = {
      profileId: liveProfile.id,
      name: liveProfile.name,
      role: liveRole,
      is_kids: liveKids,
      vault: Boolean(decoded.vault && liveRole === 'owner' && !liveKids),
    };
    req.profile = sanitizeProfile(liveProfile);
  } else {
    const role = decoded.role || (decoded.profileId === 'default' ? 'owner' : 'member');
    const isKids = Boolean(decoded.is_kids);
    req.user = {
      profileId: decoded.profileId,
      name: decoded.name || 'Owner',
      role,
      is_kids: isKids,
      vault: Boolean(decoded.vault && role === 'owner' && !isKids),
    };
  }

  next();
}

/**
 * Express middleware restricting administrative, ingestion, and vault endpoints to Owner profiles.
 */
export function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner' || req.user.is_kids) {
    return res.status(403).json({ error: 'Owner permissions required for this action' });
  }
  next();
}

/**
 * Unified server-side Private Vault authorization check.
 * Strictly blocks non-owner and Kids profiles even if PRIVATE_PIN is supplied.
 */
export function isVaultAuthorized(req) {
  // Decode optional query/header token if requireAuth wasn't run (e.g. thumbnail endpoint)
  let user = req.user;
  if (!user) {
    const tok = extractTokenFromRequest(req);
    if (tok) {
      const dec = verifyToken(tok);
      if (dec?.profileId) {
        const live = profilesDB.getRawById(dec.profileId);
        const role = live ? (live.role || (live.id === 'default' ? 'owner' : 'member')) : dec.role;
        const isKids = live ? Boolean(live.is_kids) : Boolean(dec.is_kids);
        user = {
          profileId: dec.profileId,
          role,
          is_kids: isKids,
          vault: Boolean(dec.vault && role === 'owner' && !isKids),
        };
      }
    }
  }

  if (user) {
    if (user.role !== 'owner' || user.is_kids) {
      return false;
    }
    if (user.vault === true) {
      return true;
    }
  }

  const pin = req.headers?.['x-vault-pin'] || req.query?.pin;
  if (!pin || pin.toString().trim() !== config.privatePin.toString().trim()) {
    return false;
  }

  // If authenticated as a non-owner/kids user, we already returned false above.
  // If unauthenticated (thumbnail <img> with ?pin=), allow valid PIN.
  return true;
}

/**
 * Lightweight zero-dependency sliding-window rate limiter for login & PIN endpoints.
 */
export function createAuthRateLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 12, resetOnSuccess = true } = {}) {
  const attemptsByIp = new Map();

  const middleware = (req, res, next) => {
    const ip = getClientIp(req);

    const now = Date.now();
    const cutoff = now - windowMs;
    const history = (attemptsByIp.get(ip) || []).filter((ts) => ts > cutoff);

    if (history.length >= maxAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((history[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Too many authentication attempts. Please try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      });
    }

    // Track failed attempts on finish so valid logins don't penalize the IP
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
        const cur = (attemptsByIp.get(ip) || []).filter((ts) => ts > Date.now() - windowMs);
        cur.push(Date.now());
        attemptsByIp.set(ip, cur);
      } else if (resetOnSuccess && res.statusCode >= 200 && res.statusCode < 300) {
        attemptsByIp.delete(ip);
      }
    });

    next();
  };

  middleware.reset = () => attemptsByIp.clear();
  return middleware;
}

export default {
  getClientIp,
  verifyPassword,
  hashPasscode,
  verifyPasscodeHash,
  authenticateByCode,
  generateToken,
  verifyToken,
  extractTokenFromRequest,
  requireAuth,
  requireOwner,
  isVaultAuthorized,
  createAuthRateLimiter,
};
