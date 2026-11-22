import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  gcpProjectId: process.env.GCP_PROJECT_ID || 'ismizo',
  gcsBucketName: process.env.GCS_BUCKET_NAME || 'torrentz',
  jwtSecret: process.env.JWT_SECRET || 'kodimi_default_dev_secret_key_2026',
  adminPassword: process.env.ADMIN_PASSWORD || 'kodimi123',
  privatePin: process.env.PRIVATE_PIN || '1234',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  gcpKeyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI || '',
  isWorker: process.env.IS_WORKER === 'true',
  workerServiceUrl: process.env.WORKER_SERVICE_URL || null,
  serviceUrl: process.env.SERVICE_URL || 'https://kodimi.mnembo.com',
  ytDlpPath: process.env.YT_DLP_PATH || '',
  ytDlpCookiesB64: process.env.YT_DLP_COOKIES_B64 || '',
};

if (config.nodeEnv === 'production') {
  if (config.jwtSecret === 'kodimi_default_dev_secret_key_2026') {
    console.warn('[Security Warning] JWT_SECRET is using the default dev fallback in production!');
  }
  if (config.adminPassword === 'kodimi123') {
    console.warn('[Security Warning] ADMIN_PASSWORD is using the default dev fallback in production!');
  }
  if (config.privatePin === '1234') {
    console.warn('[Security Warning] PRIVATE_PIN is using the default dev fallback in production!');
  }
}

export default config;
