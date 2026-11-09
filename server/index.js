// HTTP server: serves the UI, exposes a small JSON API, keeps API keys server-side.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT, DATA_DIR, OUTPUT_DIR } from './config.js';
import { listProviders, getProvider } from './providers/index.js';
import { getUsage, resetUsage } from './store.js';
import * as queue from './queue.js';
import { stitch } from './stitch.js';

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: config.maxImages },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype)),
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

app.get('/api/providers', (_req, res) => {
  res.json({ providers: listProviders(), maxImages: config.maxImages });
});

app.get('/api/usage', async (req, res) => {
  const usage = getUsage();
  const balances = {};
  if (req.query.balance === '1') {
    await Promise.all(listProviders().filter((p) => p.configured).map(async (p) => {
      balances[p.id] = await getProvider(p.id).getBalance().catch(() => null);
    }));
  }
  res.json({ ...usage, balances });
});

app.post('/api/usage/reset', (_req, res) => {
  resetUsage();
  res.json(getUsage());
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: queue.listJobs(), queue: queue.getQueueState() });
});

function cleanup(files) {
  for (const f of files || []) fs.rmSync(f.path, { force: true });
}

app.post('/api/jobs', upload.array('images', config.maxImages), (req, res) => {
  const files = req.files || [];
  const bad = (msg) => { cleanup(files); res.status(400).json({ error: msg }); };

  const provider = getProvider(req.body.provider);
  if (!provider) return bad('Unknown provider');
  if (!provider.isConfigured()) return bad(`${provider.label} is not configured (set ${provider.envKey} in .env)`);

  const prompt = String(req.body.prompt || '').trim();
  if (!prompt) return bad('Prompt is required');

  const cap = provider.capabilities;
  const duration = Number.parseInt(req.body.duration, 10);
  if (!(duration >= cap.minDuration && duration <= cap.maxDuration)) {
    return bad(`Duration must be ${cap.minDuration}-${cap.maxDuration}s for ${provider.label}. For longer videos, generate clips and stitch them.`);
  }
  const resolution = String(req.body.resolution);
  if (!cap.resolutions.includes(resolution)) return bad(`Resolution must be one of ${cap.resolutions.join(', ')}`);
  const aspectRatio = String(req.body.aspectRatio);
  if (!cap.aspectRatios.includes(aspectRatio)) return bad(`Aspect ratio must be one of ${cap.aspectRatios.join(', ')}`);
  if (files.length > Math.min(config.maxImages, cap.maxImages)) return bad(`Max ${Math.min(config.maxImages, cap.maxImages)} images`);

  const count = Math.min(Math.max(Number.parseInt(req.body.count, 10) || 1, 1), 20);
  const usage = getUsage();
  if (count > usage.remaining) {
    return bad(`Only ${usage.remaining} generations left under MAX_GENERATIONS_TOTAL=${usage.limit}`);
  }

  const ids = queue.enqueue({
    provider: provider.id,
    prompt,
    duration,
    resolution,
    aspectRatio,
    count,
    images: files.map((f) => ({ path: f.path, filename: f.originalname, mimetype: f.mimetype })),
  });
  res.status(201).json({ ids });
});

app.delete('/api/jobs/:id', (req, res) => {
  res.json({ ok: queue.cancelJob(req.params.id) });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  res.json({ ok: queue.retryJob(req.params.id) });
});

app.post('/api/queue/resume', (_req, res) => {
  queue.resume();
  res.json(queue.getQueueState());
});

app.post('/api/queue/clear', (_req, res) => {
  res.json({ cancelled: queue.clearQueued() });
});

app.post('/api/jobs/clear-finished', (_req, res) => {
  queue.removeFinished();
  res.json({ ok: true });
});

app.post('/api/stitch', async (req, res) => {
  try {
    const files = (req.body.jobIds || []).map((id) => {
      const job = queue.getJob(id);
      if (!job?.file) throw new Error(`Job ${id} has no finished video`);
      return job.file;
    });
    res.json({ file: await stitch(files) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

app.listen(config.port, config.host, () => {
  console.log(`Video UI running at http://${config.host}:${config.port}`);
  for (const p of listProviders()) {
    console.log(`  - ${p.label.padEnd(28)} ${p.configured ? 'ready' : `not configured (${p.envKey})`}`);
  }
});
