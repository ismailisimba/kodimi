import express from 'express';
import { requireAuth, requireOwner, isVaultAuthorized, generateToken } from '../services/auth.js';
import {
  profilesDB,
  lockoutsDB,
  resetRequestsDB,
  ensureProfilesFresh,
  generateUniquePasscode,
} from '../db/database.js';

const router = express.Router();

async function syncProfilesMiddleware(req, res, next) {
  await ensureProfilesFresh(false);
  next();
}

/**
 * List all user profiles (Owner-only so profile names remain hidden from other profiles)
 */
router.get('/', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  await ensureProfilesFresh(true);
  const profiles = profilesDB.getAll();
  res.json({ profiles });
});

/**
 * Generate a unique random login code suggestion (Owner-only)
 */
router.post('/generate-code', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  await ensureProfilesFresh(true);
  const code = generateUniquePasscode();
  res.json({ code });
});

/**
 * List pending profile reset requests (Owner-only in-app ping inbox)
 */
router.get('/reset-requests', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  await ensureProfilesFresh(true);
  const requests = await resetRequestsDB.getPending();
  res.json({ pendingCount: requests.length, requests });
});

/**
 * Resolve a profile reset request: reset code & unlock IP, unlock IP only, or dismiss (Owner-only)
 */
router.post('/reset-requests/:requestId/resolve', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  const { requestId } = req.params;
  const { action = 'reset', profileId, newPasscode, generateCode } = req.body || {};

  const reqDoc = await resetRequestsDB.getById(requestId);
  if (!reqDoc) {
    return res.status(404).json({ error: 'Reset request not found' });
  }

  try {
    if (action === 'dismiss') {
      const updatedReq = await resetRequestsDB.markResolved(requestId, {
        status: 'dismissed',
        resolutionNote: 'Dismissed by owner',
      });
      return res.json({ success: true, action: 'dismiss', request: updatedReq });
    }

    if (action === 'unlock_only') {
      await lockoutsDB.clear(reqDoc.client_ip);
      const updatedReq = await resetRequestsDB.markResolved(requestId, {
        status: 'resolved',
        resolvedProfileId: reqDoc.matched_profile_id || null,
        resolutionNote: 'Sign-in unlocked without changing code',
      });
      return res.json({ success: true, action: 'unlock_only', request: updatedReq });
    }

    if (action !== 'reset') {
      return res.status(400).json({ error: 'Invalid resolution action' });
    }

    await ensureProfilesFresh(true);
    const targetId = profileId || reqDoc.matched_profile_id;
    if (!targetId) {
      return res.status(400).json({ error: 'Select which profile to reset' });
    }

    const targetProfile = profilesDB.getRawById(targetId);
    if (!targetProfile) {
      return res.status(404).json({ error: 'Target profile not found' });
    }

    const codeToSet =
      generateCode || !String(newPasscode || '').trim()
        ? generateUniquePasscode()
        : String(newPasscode).trim();

    const updatedProfile = await profilesDB.update(targetId, {
      passcode: codeToSet,
      autoResolvePendingRequests: false,
    });

    await lockoutsDB.clear(reqDoc.client_ip);
    const updatedReq = await resetRequestsDB.markResolved(requestId, {
      status: 'resolved',
      resolvedProfileId: targetId,
      resolutionNote: `Login code reset for ${updatedProfile.name}`,
    });

    // Also clear any duplicate pending requests from the same locked IP for this profile
    const remainingPending = await resetRequestsDB.getPending();
    for (const other of remainingPending) {
      if (other.id !== requestId && other.client_ip === reqDoc.client_ip) {
        await resetRequestsDB.markResolved(other.id, {
          status: 'resolved',
          resolvedProfileId: targetId,
          resolutionNote: `Resolved with request ${requestId}`,
        });
      }
    }

    const shareMessage = `Your Kodimi login code for "${updatedProfile.name}" has been reset. Your new code is: ${codeToSet}`;
    const shareWhatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    const refreshedToken =
      targetId === req.user.profileId
        ? generateToken(updatedProfile, { vault: req.user.vault })
        : undefined;

    return res.json({
      success: true,
      action: 'reset',
      profile: updatedProfile,
      newCode: codeToSet,
      shareMessage,
      shareWhatsappUrl,
      request: updatedReq,
      ...(refreshedToken ? { token: refreshedToken } : {}),
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Create a new user profile with a unique login code (Owner-only)
 */
router.post('/', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  const { name, avatar, color, is_kids, passcode } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Profile name is required' });
  }
  if (!passcode || String(passcode).trim().length < 4) {
    return res.status(400).json({ error: 'A unique login code (at least 4 characters) is required' });
  }

  try {
    const profile = await profilesDB.create({
      name: String(name).trim(),
      avatar,
      color,
      is_kids,
      role: 'member',
      passcode: String(passcode).trim(),
    });
    res.status(201).json({ success: true, profile });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Update an existing user profile, including setting/updating its unique login code (Owner-only)
 */
router.put('/:id', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  const { id } = req.params;
  const { name, avatar, color, is_kids, passcode } = req.body || {};
  const hasNewPasscode = passcode !== undefined && String(passcode).trim() !== '';

  try {
    const profile = await profilesDB.update(id, {
      name,
      avatar,
      color,
      is_kids,
      ...(hasNewPasscode ? { passcode: String(passcode).trim() } : {}),
    });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const refreshedToken =
      hasNewPasscode && id === req.user.profileId
        ? generateToken(profile, { vault: req.user.vault })
        : undefined;
    res.json({ success: true, profile, ...(refreshedToken ? { token: refreshedToken } : {}) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a user profile (Owner-only; prevents deleting primary Owner or last profile)
 */
router.delete('/:id', syncProfilesMiddleware, requireAuth, requireOwner, async (req, res) => {
  const { id } = req.params;
  try {
    await profilesDB.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * Get watchlist / favorites for the authenticated profile (strictly isolated per profile)
 */
router.get('/:id/watchlist', syncProfilesMiddleware, requireAuth, (req, res) => {
  const { id } = req.params;
  if (id !== req.user.profileId) {
    return res.status(403).json({ error: 'Cannot access another profile watchlist' });
  }
  const allowAdult = isVaultAuthorized(req);
  const items = profilesDB.getWatchlist(req.user.profileId, allowAdult);
  res.json({ items });
});

/**
 * Toggle watchlist bookmark for the authenticated profile (strictly isolated per profile)
 */
router.post('/:id/watchlist/:mediaId', syncProfilesMiddleware, requireAuth, async (req, res) => {
  const { id, mediaId } = req.params;
  if (id !== req.user.profileId) {
    return res.status(403).json({ error: 'Cannot modify another profile watchlist' });
  }
  try {
    const result = await profilesDB.toggleWatchlist(req.user.profileId, mediaId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
