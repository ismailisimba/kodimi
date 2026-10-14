import express from 'express';
import { verifyPassword, generateToken, requireAuth } from '../services/auth.js';
import config from '../config/env.js';

const router = express.Router();

router.post('/login', (req, res) => {
  const { password } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = generateToken();
  res.json({
    token,
    user: {
      username: 'admin',
      role: 'owner',
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      username: 'admin',
      role: 'owner',
    },
    authenticated: true,
  });
});

router.post('/verify-pin', requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.toString().trim() !== config.privatePin.toString().trim()) {
    return res.status(400).json({ error: 'Incorrect Vault PIN' });
  }

  const vaultToken = generateToken({ user: 'admin', vault: true });
  res.json({ success: true, vaultToken });
});

export default router;
