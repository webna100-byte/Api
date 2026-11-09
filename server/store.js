// Tiny JSON-file persistence for usage counters and job history.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config, envInt } from './config.js';

const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- usage -------------------------------------------------------------
const usage = readJson(USAGE_FILE, { total: 0, byProvider: {} });

export function providerLimit(providerId) {
  // Optional per-provider cap, e.g. WAVESPEED_MAX_GENERATIONS=3
  return envInt(`${providerId.toUpperCase()}_MAX_GENERATIONS`, null);
}

export function canGenerate(providerId) {
  if (usage.total >= config.maxGenerationsTotal) {
    return { ok: false, reason: `Total generation limit reached (${config.maxGenerationsTotal}). Raise MAX_GENERATIONS_TOTAL in .env to continue.` };
  }
  const lim = providerLimit(providerId);
  const used = usage.byProvider[providerId]?.count || 0;
  if (lim !== null && used >= lim) {
    return { ok: false, reason: `${providerId} limit reached (${lim}).` };
  }
  return { ok: true };
}

/** Called right after a task is accepted by the provider (that is when it is billed). */
export function recordSubmission(providerId, seconds, resolution) {
  usage.total += 1;
  const p = (usage.byProvider[providerId] ||= { count: 0, seconds: 0, byResolution: {} });
  p.count += 1;
  p.seconds += seconds;
  p.byResolution[resolution] = (p.byResolution[resolution] || 0) + 1;
  writeJson(USAGE_FILE, usage);
}

export function getUsage() {
  const byProvider = {};
  for (const [id, v] of Object.entries(usage.byProvider)) {
    byProvider[id] = { ...v, limit: providerLimit(id) };
  }
  return {
    total: usage.total,
    limit: config.maxGenerationsTotal,
    remaining: Math.max(0, config.maxGenerationsTotal - usage.total),
    byProvider,
  };
}

export function resetUsage() {
  usage.total = 0;
  usage.byProvider = {};
  writeJson(USAGE_FILE, usage);
}

// ---- jobs --------------------------------------------------------------
export function loadJobs() {
  return readJson(JOBS_FILE, []);
}

export function saveJobs(jobs) {
  writeJson(JOBS_FILE, jobs);
}
