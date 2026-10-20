import express from 'express';
import { requireAuth } from '../services/auth.js';
import { profilesDB } from '../db/database.js';

const router = express.Router();

function isVaultAuthorized(req) {
  const pin = req.headers['x-vault-pin'];
  return pin && pin === (process.env.PRIVATE_PIN || '1234');
}

/**
 * List all user profiles
 */
router.get('/', requireAuth, (req, res) => {
  const profiles = profilesDB.getAll();
  res.json({ profiles });
});

/**
 * Create a new user profile
 */
router.post('/', requireAuth, async (req, res) => {
  const { name, avatar, color, is_kids } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Profile name is required' });
  }

  try {
    const profile = await profilesDB.create({ name, avatar, color, is_kids });
    res.status(201).json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update an existing user profile
 */
router.put('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, avatar, color, is_kids } = req.body;

  try {
    const profile = await profilesDB.update(id, { name, avatar, color, is_kids });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a user profile (prevent deleting the last profile)
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await profilesDB.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get watchlist / favorites for a profile
 */
router.get('/:id/watchlist', requireAuth, (req, res) => {
  const { id } = req.params;
  const allowAdult = isVaultAuthorized(req);
  const items = profilesDB.getWatchlist(id, allowAdult);
  res.json({ items });
});

/**
 * Toggle watchlist bookmark for a media item
 */
router.post('/:id/watchlist/:mediaId', requireAuth, async (req, res) => {
  const { id, mediaId } = req.params;
  try {
    const result = await profilesDB.toggleWatchlist(id, mediaId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
