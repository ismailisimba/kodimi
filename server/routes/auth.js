import express from 'express';
import {
  authenticateByCode,
  generateToken,
  requireAuth,
  requireOwner,
  verifyPasscodeHash,
  createAuthRateLimiter,
} from '../services/auth.js';
import { profilesDB, sanitizeProfile } from '../db/database.js';
import config from '../config/env.js';

const router = express.Router();

export const loginRateLimiter = createAuthRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 12 });
export const pinRateLimiter = createAuthRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

/**
 * POST /api/auth/login
 * Code-only authentication: matches a unique per-profile login code without revealing profile names pre-auth.
 */
router.post('/login', loginRateLimiter, (req, res) => {
  const rawCode = req.body?.code ?? req.body?.password;
  if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) {
    return res.status(401).json({ error: 'Invalid login code' });
  }

  const profile = authenticateByCode(rawCode);
  if (!profile) {
    return res.status(401).json({ error: 'Invalid login code' });
  }

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
 * GET /api/auth/me
 * Returns the currently authenticated profile bound to the JWT.
 */
router.get('/me', requireAuth, (req, res) => {
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
 * Allows any authenticated profile to update their OWN unique login code.
 */
router.post('/change-code', requireAuth, loginRateLimiter, async (req, res) => {
  const { currentCode, newCode } = req.body || {};
  if (!currentCode || !newCode) {
    return res.status(400).json({ error: 'Both current and new login codes are required' });
  }

  const rawProfile = profilesDB.getRawById(req.user.profileId);
  if (!rawProfile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (rawProfile.passcode_hash && !verifyPasscodeHash(currentCode, rawProfile.passcode_hash)) {
    return res.status(401).json({ error: 'Current login code is incorrect' });
  }

  const cleanNew = String(newCode).trim();
  if (cleanNew.length < 4) {
    return res.status(400).json({ error: 'New login code must be at least 4 characters' });
  }

  try {
    const updated = await profilesDB.update(rawProfile.id, { passcode: cleanNew });
    res.json({ success: true, profile: updated });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/verify-pin
 * Owner-only Private Vault PIN verification.
 */
router.post('/verify-pin', requireAuth, requireOwner, pinRateLimiter, (req, res) => {
  const { pin } = req.body || {};
  if (!pin || pin.toString().trim() !== config.privatePin.toString().trim()) {
    return res.status(400).json({ error: 'Incorrect Vault PIN' });
  }

  const vaultToken = generateToken(
    {
      id: req.user.profileId,
      name: req.user.name,
      role: req.user.role,
      is_kids: req.user.is_kids,
    },
    { vault: true }
  );
  res.json({ success: true, vaultToken });
});

export default router;
