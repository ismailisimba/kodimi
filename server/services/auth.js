import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';

export function verifyPassword(inputPassword) {
  if (!inputPassword) return false;
  // Support both plain text match or bcrypt hashed comparison
  if (inputPassword === config.adminPassword) return true;
  try {
    return bcrypt.compareSync(inputPassword, config.adminPassword);
  } catch {
    return false;
  }
}

export function generateToken(payload = { user: 'admin' }) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/**
 * Express middleware to protect routes.
 * Supports token via Header (Bearer) or Query param (?token=) for video streaming.
 */
export function requireAuth(req, res, next) {
  let token = null;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

export default {
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
};
