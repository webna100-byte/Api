// Offline mock provider: renders a test-pattern video locally with ffmpeg.
// Lets you exercise the UI, queue, limits and download flow with zero keys
// and zero cost. Set MOCK_CREDIT_FAIL_AFTER=N to simulate "out of credit"
// after N submissions (to test that the queue stops).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { envBool, envInt, DATA_DIR } from '../config.js';
import { ProviderError } from './http.js';

const MOCK_DIR = path.join(DATA_DIR, 'mock');
const tasks = new Map();
let submissions = 0;

const SIZES = { '480p': 480, '720p': 720, '1080p': 1080 };

function dims(resolution, aspectRatio) {
  const short = SIZES[resolution] || 480;
  const [w, h] = (aspectRatio === 'adaptive' ? '16:9' : aspectRatio).split(':').map(Number);
  const even = (n) => Math.round(n / 2) * 2;
  return w >= h ? [even((short * w) / h), short] : [short, even((short * h) / w)];
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exit ${code}`))));
  });
}

async function render(file, { duration, resolution, aspectRatio, prompt }) {
  const [w, h] = dims(resolution, aspectRatio);
  const label = prompt.slice(0, 40).replace(/[^A-Za-z0-9 ]/g, ' ');
  const inputs = [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
  ];
  const out = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file];
  const text = `drawtext=text='MOCK ${resolution} ${label}':fontcolor=white:fontsize=${Math.round(h / 18)}:x=20:y=20:box=1:boxcolor=black@0.5`;
  try {
    await ffmpeg([...inputs, '-vf', text, ...out]);
  } catch {
    await ffmpeg([...inputs, ...out]); // drawtext unavailable (no fontconfig)
  }
}

const provider = {
  id: 'mock',
  label: 'Mock (local ffmpeg, free)',
  envKey: null,
  baseUrl: 'local',
  model: 'ffmpeg-testsrc',
  modelText: 'ffmpeg-testsrc',
  capabilities: {
    minDuration: 2,
    maxDuration: 20,
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    maxImages: 5,
  },

  isConfigured() {
    return envBool('MOCK_ENABLED', true);
  },

  uploadEndpoint() {
    return null; // handled locally
  },

  async uploadImage({ filename }) {
    return `mock://${encodeURIComponent(filename)}`;
  },

  async createTask(params) {
    submissions += 1;
    const failAfter = envInt('MOCK_CREDIT_FAIL_AFTER', 0);
    if (failAfter > 0 && submissions > failAfter) {
      throw new ProviderError('HTTP 402: Insufficient balance (simulated)', 'credit', 402);
    }
    fs.mkdirSync(MOCK_DIR, { recursive: true });
    const taskId = crypto.randomUUID();
    const file = path.join(MOCK_DIR, `${taskId}.mp4`);
    const task = { status: 'running', file, readyAt: Date.now() + envInt('MOCK_DELAY_MS', 3000) };
    tasks.set(taskId, task);
    render(file, params).then(
      () => { task.rendered = true; },
      (e) => { task.status = 'failed'; task.error = e.message; },
    );
    return { taskId, model: this.model };
  },

  async getStatus(taskId) {
    const t = tasks.get(taskId);
    if (!t) return { status: 'failed', error: 'unknown mock task' };
    if (t.status === 'failed') return { status: 'failed', error: t.error };
    if (t.rendered && Date.now() >= t.readyAt) return { status: 'succeeded', videoUrl: `file://${t.file}` };
    return { status: 'running' };
  },

  async getResult(taskId) {
    const s = await this.getStatus(taskId);
    if (s.status !== 'succeeded') throw new ProviderError('Result not ready', 'task_failed');
    return s.videoUrl;
  },

  async getBalance() {
    const failAfter = envInt('MOCK_CREDIT_FAIL_AFTER', 0);
    return failAfter > 0 ? { amount: Math.max(0, failAfter - submissions), unit: 'videos' } : null;
  },
};

export default provider;
