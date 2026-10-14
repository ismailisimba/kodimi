import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from './config/env.js';
import { mediaDB, initDatabase } from './db/database.js';
import { scanAndIndexBucket } from './services/scanner.js';

import authRoutes from './routes/auth.js';
import mediaRoutes from './routes/media.js';
import streamRoutes from './routes/stream.js';
import downloadsRoutes from './routes/downloads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/downloads', downloadsRoutes);

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'kodimi', timestamp: new Date().toISOString() });
});

// Serve static frontend from public/
const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));

// Fallback to index.html for non-API routes (SPA support)
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Initialize Database and Start Server
async function start() {
  await initDatabase();

  app.listen(config.port, '0.0.0.0', () => {
    console.log('==============================================');
    console.log(`🎬 Kodimi Media Server running on port ${config.port}`);
    console.log(`📡 Environment: ${config.nodeEnv}`);
    console.log(`🪣 GCS Bucket: gs://${config.gcsBucketName}`);
    console.log('==============================================');

    // Initial auto-sync of bucket if catalog is empty or on startup
    const existingItems = mediaDB.getAll({ limit: 1 });
    if (existingItems.length === 0) {
      console.log('[Startup] Media catalog is empty. Initiating automatic GCS bucket scan...');
      scanAndIndexBucket();
    } else {
      console.log(`[Startup] Media catalog contains ${mediaDB.getAll({ limit: 1000 }).length} indexed files. Ready to stream.`);
    }
  });
}

start().catch(console.error);
