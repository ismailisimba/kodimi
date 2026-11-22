import express from 'express';
import { requireAuth, requireOwner, isVaultAuthorized } from '../services/auth.js';
import { profilesDB } from '../db/database.js';

const router = express.Router();

/**
 * List all user profiles (Owner-only so profile names remain hidden from other profiles)
 */
router.get('/', requireAuth, requireOwner, (req, res) => {
  const profiles = profilesDB.getAll();
  res.json({ profiles });
});

/**
 * Create a new user profile with a unique login code (Owner-only)
 */
router.post('/', requireAuth, requireOwner, async (req, res) => {
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
router.put('/:id', requireAuth, requireOwner, async (req, res) => {
  const { id } = req.params;
  const { name, avatar, color, is_kids, passcode } = req.body || {};

  try {
    const profile = await profilesDB.update(id, {
      name,
      avatar,
      color,
      is_kids,
      ...(passcode !== undefined && String(passcode).trim() !== '' ? { passcode: String(passcode).trim() } : {}),
    });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ success: true, profile });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a user profile (Owner-only; prevents deleting primary Owner or last profile)
 */
router.delete('/:id', requireAuth, requireOwner, async (req, res) => {
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
router.get('/:id/watchlist', requireAuth, (req, res) => {
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
router.post('/:id/watchlist/:mediaId', requireAuth, async (req, res) => {
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
