// Loads .env (server-side only) and exposes typed config values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const OUTPUT_DIR = path.join(ROOT, 'output');

const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(name, fallback) {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name, fallback = false) {
  const v = env(name, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export const config = {
  port: envInt('PORT', 3000),
  host: env('HOST', '127.0.0.1'),
  // Hard caps so a free credit balance is never burned by accident.
  maxGenerationsTotal: envInt('MAX_GENERATIONS_TOTAL', 20),
  maxImages: 5,
  pollIntervalMs: envInt('POLL_INTERVAL_MS', 5000),
  taskTimeoutMs: envInt('TASK_TIMEOUT_MS', 20 * 60 * 1000),
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
