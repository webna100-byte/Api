// Sequential generation queue.
// One job at a time: create task -> poll -> download.
// (Images are uploaded to the provider beforehand via POST /api/upload.)
// Stops (pauses) on a credit/quota error or when a usage limit is reached,
// leaving remaining jobs queued so you can resume after fixing it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, OUTPUT_DIR } from './config.js';
import { getProvider } from './providers/index.js';
import { ProviderError } from './providers/http.js';
import { canGenerate, recordSubmission, loadJobs, saveJobs } from './store.js';

const ACTIVE = new Set(['uploading', 'submitting', 'running', 'downloading']);
const TRANSIENT = new Set(['network', 'rate', 'server']);

const jobs = loadJobs();
const state = { paused: false, pauseReason: null, working: false };
const listeners = new Set();

// Recover from a restart: tasks already submitted keep polling (results live ~24h);
// tasks that never reached the provider go back to the queue.
for (const j of jobs) {
  if (ACTIVE.has(j.status)) j.status = j.taskId ? 'running' : 'queued';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function persist() {
  saveJobs(jobs);
  for (const fn of listeners) fn();
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  persist();
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getQueueState() {
  return {
    ...state,
    queued: jobs.filter((j) => j.status === 'queued').length,
    active: jobs.filter((j) => ACTIVE.has(j.status)).length,
  };
}

export function listJobs() {
  return jobs.map((j) => ({ ...j, imageCount: j.imageUrls?.length || 0 }));
}

export function getJob(id) {
  return jobs.find((j) => j.id === id);
}

/**
 * @param {object} spec  {provider, prompt, duration, resolution, aspectRatio, imageUrls, count}
 */
export function enqueue(spec) {
  const batchId = crypto.randomUUID();
  const created = [];
  for (let i = 0; i < spec.count; i += 1) {
    const job = {
      id: crypto.randomUUID(),
      batchId,
      provider: spec.provider,
      prompt: spec.prompt,
      duration: spec.duration,
      resolution: spec.resolution,
      aspectRatio: spec.aspectRatio,
      imageUrls: spec.imageUrls,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    jobs.push(job);
    created.push(job.id);
  }
  persist();
  kick();
  return created;
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!job) return false;
  if (job.status !== 'queued') return false; // submitted tasks are already billed
  update(job, { status: 'cancelled' });
  return true;
}

export function clearQueued() {
  let n = 0;
  for (const j of jobs) if (j.status === 'queued') { j.status = 'cancelled'; n += 1; }
  persist();
  return n;
}

export function retryJob(id) {
  const job = getJob(id);
  if (!job || !['failed', 'cancelled'].includes(job.status)) return false;
  update(job, { status: 'queued', error: null, errorKind: null, taskId: null, remoteUrl: null });
  kick();
  return true;
}

export function removeFinished() {
  const keep = jobs.filter((j) => j.status === 'queued' || ACTIVE.has(j.status));
  jobs.length = 0;
  jobs.push(...keep);
  persist();
}

export function resume() {
  state.paused = false;
  state.pauseReason = null;
  persist();
  kick();
}

function pause(reason) {
  state.paused = true;
  state.pauseReason = reason;
  persist();
}

function kick() {
  if (state.working) return;
  state.working = true;
  work().catch((e) => console.error('[queue] worker crashed:', e)).finally(() => { state.working = false; });
}

async function work() {
  for (;;) {
    // Jobs already submitted (e.g. after restart) are polled even while paused:
    // they are paid for, so we must still collect the result.
    const inflight = jobs.find((j) => j.status === 'running' && j.taskId);
    if (inflight) { await pollAndDownload(inflight); continue; }
    if (state.paused) return;
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    await runJob(next);
  }
}

async function runJob(job) {
  const provider = getProvider(job.provider);
  if (!provider || !provider.isConfigured()) {
    update(job, { status: 'failed', errorKind: 'config', error: `Provider "${job.provider}" is not configured` });
    return;
  }

  const gate = canGenerate(provider.id);
  if (!gate.ok) {
    pause(gate.reason);
    return;
  }

  try {
    update(job, { status: 'submitting' });
    // Never auto-retry submission: a retry after an unclear failure can create a second billed task.
    const { taskId, model } = await provider.createTask({
      prompt: job.prompt,
      imageUrls: job.imageUrls || [],
      duration: job.duration,
      resolution: job.resolution,
      aspectRatio: job.aspectRatio,
    });
    recordSubmission(provider.id, job.duration, job.resolution);
    update(job, { status: 'running', taskId, model, submittedAt: new Date().toISOString() });
    await pollAndDownload(job);
  } catch (err) {
    fail(job, err);
  }
}

async function pollAndDownload(job) {
  const provider = getProvider(job.provider);
  const started = Date.parse(job.submittedAt || job.updatedAt) || Date.now();
  try {
    for (;;) {
      if (Date.now() - started > config.taskTimeoutMs) {
        throw new ProviderError(`Timed out after ${Math.round(config.taskTimeoutMs / 60000)} min (task ${job.taskId} may still finish on the provider side)`, 'task_failed');
      }
      let s;
      try {
        s = await provider.getStatus(job.taskId);
      } catch (err) {
        if (err instanceof ProviderError && TRANSIENT.has(err.kind)) {
          await sleep(config.pollIntervalMs * 2);
          continue;
        }
        throw err;
      }
      if (s.status === 'succeeded') {
        if (!s.videoUrl) throw new ProviderError('Task succeeded but returned no video URL', 'task_failed');
        update(job, { status: 'downloading', remoteUrl: s.videoUrl });
        const file = await download(job, s.videoUrl);
        update(job, { status: 'succeeded', file, finishedAt: new Date().toISOString() });
        return;
      }
      if (s.status === 'failed') throw new ProviderError(String(s.error || 'Generation failed'), 'task_failed');
      if (job.providerStatus !== s.raw && s.raw) update(job, { providerStatus: s.raw });
      await sleep(config.pollIntervalMs);
    }
  } catch (err) {
    fail(job, err);
  }
}

function fail(job, err) {
  const kind = err instanceof ProviderError ? err.kind : 'server';
  update(job, { status: 'failed', errorKind: kind, error: err.message });
  console.error(`[queue] job ${job.id} failed (${kind}): ${err.message}`);
  if (kind === 'credit') pause(`Out of credit on ${job.provider}: ${err.message}`);
  if (kind === 'auth') pause(`API key rejected by ${job.provider}: ${err.message}`);
}

async function download(job, url) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}_${job.provider}_${job.resolution}_${job.duration}s_${job.id.slice(0, 8)}.mp4`;
  const dest = path.join(OUTPUT_DIR, name);
  if (url.startsWith('file://')) {
    fs.copyFileSync(new URL(url), dest);
    return name;
  }
  // Provider links expire (BytePlus/Seedance: 24h), so fetch immediately.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return name;
    } catch (err) {
      if (attempt === 3) throw new ProviderError(`Download failed: ${err.message}. Remote URL: ${url}`, 'network');
      await sleep(3000 * attempt);
    }
  }
  return name;
}

// Pick up any recovered in-flight/queued jobs on boot.
kick();
