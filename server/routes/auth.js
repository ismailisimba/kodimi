import express from 'express';
import {
  authenticateByCode,
  generateToken,
  getClientIp,
  requireAuth,
  requireOwner,
  verifyPasscodeHash,
  createAuthRateLimiter,
} from '../services/auth.js';
import {
  profilesDB,
  lockoutsDB,
  resetRequestsDB,
  sanitizeProfile,
  ensureProfilesFresh,
  MAX_RESET_REQUESTS_PER_LOCKOUT,
} from '../db/database.js';
import config from '../config/env.js';

const router = express.Router();

export const loginRateLimiter = createAuthRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 12 });
export const changeCodeRateLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 8,
  resetOnSuccess: false,
});
export const pinRateLimiter = createAuthRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

async function syncProfilesMiddleware(req, res, next) {
  await ensureProfilesFresh(false);
  next();
}

export function buildLockoutWhatsappMessage(profileName) {
  const safeName = String(profileName || '').trim().slice(0, 40);
  return `Hi, I got locked out of Kodimi after 5 failed attempts. Could you reset the login code for my profile "${safeName}"?`;
}

/**
 * GET /api/auth/lockout-status
 * Returns whether the caller's IP is currently locked out (zero profile information disclosed).
 */
router.get('/lockout-status', async (req, res) => {
  const clientIp = getClientIp(req);
  const status = await lockoutsDB.getStatus(clientIp);
  res.json({
    locked: status.locked,
    failedAttempts: status.failedAttempts,
    maxAttempts: status.maxAttempts,
    attemptsRemaining: status.attemptsRemaining,
    lockedAt: status.lockedAt,
    expiresAt: status.expiresAt,
    requestSent: status.resetRequestCount > 0,
    canRequestReset: status.locked && status.resetRequestCount < MAX_RESET_REQUESTS_PER_LOCKOUT,
  });
});

/**
 * POST /api/auth/login
 * Code-only authentication: matches a unique per-profile login code without revealing profile names pre-auth.
 * Locks out caller after 5 failed attempts (24-hour fallback unless Owner resets/unlocks sooner).
 */
router.post('/login', async (req, res) => {
  const clientIp = getClientIp(req);
  const currentStatus = await lockoutsDB.getStatus(clientIp);

  if (currentStatus.locked) {
    return res.status(423).json({
      error: 'Too many failed attempts. Sign-in is locked until the owner resets your profile.',
      locked: true,
      failedAttempts: currentStatus.failedAttempts,
      maxAttempts: currentStatus.maxAttempts,
      attemptsRemaining: 0,
      lockedAt: currentStatus.lockedAt,
      expiresAt: currentStatus.expiresAt,
      requestSent: currentStatus.resetRequestCount > 0,
      canRequestReset: currentStatus.resetRequestCount < MAX_RESET_REQUESTS_PER_LOCKOUT,
    });
  }

  const rawCode = req.body?.code ?? req.body?.password;
  if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) {
    return res.status(401).json({
      error: 'Enter your login code',
      locked: false,
      failedAttempts: currentStatus.failedAttempts,
      maxAttempts: currentStatus.maxAttempts,
      attemptsRemaining: currentStatus.attemptsRemaining,
    });
  }

  await ensureProfilesFresh(true);
  const profile = authenticateByCode(rawCode);
  if (!profile) {
    const nextStatus = await lockoutsDB.recordFailure(clientIp);
    if (nextStatus.locked) {
      return res.status(423).json({
        error: 'Too many failed attempts. Sign-in is locked until the owner resets your profile.',
        locked: true,
        failedAttempts: nextStatus.failedAttempts,
        maxAttempts: nextStatus.maxAttempts,
        attemptsRemaining: 0,
        lockedAt: nextStatus.lockedAt,
        expiresAt: nextStatus.expiresAt,
        requestSent: false,
        canRequestReset: true,
      });
    }

    const rem = nextStatus.attemptsRemaining;
    const errorMsg =
      rem === 1
        ? 'Incorrect login code. 1 attempt remaining before lockout.'
        : `Incorrect login code. ${rem} attempts remaining.`;

    return res.status(401).json({
      error: errorMsg,
      locked: false,
      failedAttempts: nextStatus.failedAttempts,
      maxAttempts: nextStatus.maxAttempts,
      attemptsRemaining: rem,
    });
  }

  await lockoutsDB.clear(clientIp);
  const token = generateToken(profile);
  const safeProfile = sanitizeProfile(profile);

  res.json({
    token,
    profile: safeProfile,
    user: {
      profileId: safeProfile.id,
      username: safeProfile.name,
      role: safeProfile.role,
      is_kids: Boolean(safeProfile.is_kids),
    },
  });
});

/**
 * POST /api/auth/request-reset
 * Allows a locked-out user to submit their profile name to ping the Owner in-app.
 * Never reveals whether the entered profile name exists.
 */
router.post('/request-reset', async (req, res) => {
  const clientIp = getClientIp(req);
  const status = await lockoutsDB.getStatus(clientIp);

  if (!status.locked) {
    return res.status(403).json({
      error: 'Reset requests are only available after sign-in is locked.',
    });
  }

  if (status.resetRequestCount >= MAX_RESET_REQUESTS_PER_LOCKOUT) {
    return res.status(429).json({
      error: 'You already alerted the owner. Message them on WhatsApp to get your new login code.',
    });
  }

  const profileName = String(req.body?.profileName ?? '').trim();
  if (!profileName) {
    return res.status(400).json({ error: 'Enter your profile name' });
  }
  if (profileName.length > 40) {
    return res.status(400).json({ error: 'Profile name must be 40 characters or fewer' });
  }

  try {
    await resetRequestsDB.create({
      requestedName: profileName,
      clientIp,
      failedAttempts: status.failedAttempts,
    });
    await lockoutsDB.incrementResetRequestCount(clientIp);

    const whatsappMessage = buildLockoutWhatsappMessage(profileName);
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(whatsappMessage)}`;

    res.status(201).json({
      success: true,
      requestedName: profileName,
      whatsappMessage,
      whatsappUrl,
      message: 'The owner has been notified in Kodimi. Message them on WhatsApp to confirm and get your new login code.',
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated profile bound to the JWT.
 */
router.get('/me', syncProfilesMiddleware, requireAuth, (req, res) => {
  const safeProfile =
    req.profile ||
    profilesDB.getById(req.user.profileId) || {
      id: req.user.profileId,
      name: req.user.name,
      role: req.user.role,
      is_kids: Boolean(req.user.is_kids),
      avatar: 'account_circle',
      color: '#e50914',
      has_passcode: true,
    };

  res.json({
    authenticated: true,
    profile: safeProfile,
    user: {
      profileId: safeProfile.id,
      username: safeProfile.name,
      role: safeProfile.role,
      is_kids: Boolean(safeProfile.is_kids),
    },
  });
});

/**
 * POST /api/auth/change-code
 * Owner-only: allows the Owner to update their own unique login code without risking
 * member-driven password discovery probes.
 */
router.post('/change-code', syncProfilesMiddleware, requireAuth, requireOwner, changeCodeRateLimiter, async (req, res) => {
  const { currentCode, newCode } = req.body || {};
  if (!currentCode || !newCode) {
    return res.status(400).json({ error: 'Both current and new login codes are required' });
  }

  await ensureProfilesFresh(true);
  const rawProfile = profilesDB.getRawById(req.user.profileId);
  if (!rawProfile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (rawProfile.passcode_hash && !verifyPasscodeHash(currentCode, rawProfile.passcode_hash)) {
    return res.status(400).json({ error: 'Current login code is incorrect' });
  }

  const cleanNew = String(newCode).trim();
  if (cleanNew.length < 4) {
    return res.status(400).json({ error: 'New login code must be at least 4 characters' });
  }

  try {
    const updated = await profilesDB.update(rawProfile.id, { passcode: cleanNew });
    const token = generateToken(updated, { vault: req.user.vault });
    res.json({ success: true, profile: updated, token });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/verify-pin
 * Owner-only Private Vault PIN verification.
 */
router.post('/verify-pin', syncProfilesMiddleware, requireAuth, requireOwner, pinRateLimiter, (req, res) => {
  const { pin } = req.body || {};
  if (!pin || pin.toString().trim() !== config.privatePin.toString().trim()) {
    return res.status(400).json({ error: 'Incorrect Vault PIN' });
  }

  const rawProfile = profilesDB.getRawById(req.user.profileId);
  const vaultToken = generateToken(
    {
      id: req.user.profileId,
      name: req.user.name,
      role: req.user.role,
      is_kids: req.user.is_kids,
      passcode_version: Number(rawProfile?.passcode_version || 0),
    },
    { vault: true }
  );
  res.json({ success: true, vaultToken });
});

export default router;
