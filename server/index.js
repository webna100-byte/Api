// Local HTTP server: serves the UI, exposes a small JSON API, keeps API keys server-side.
// The same API is implemented for Cloudflare in cloudflare/src/worker.js.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { config, ROOT, OUTPUT_DIR } from './config.js';
import { listProviders, getProvider } from './providers/index.js';
import { validateJob, MAX_IMAGES } from './validate.js';
import { getUsage, resetUsage } from './store.js';
import * as queue from './queue.js';
import { stitch } from './stitch.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

app.get('/api/providers', (_req, res) => {
  res.json({
    providers: listProviders(),
    maxImages: MAX_IMAGES,
    features: { stitch: true, auth: false, serverFiles: true },
  });
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

// Step 1: upload one reference image to the chosen provider -> { url }.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const provider = getProvider(String(req.query.provider));
  if (!provider?.isConfigured()) return res.status(400).json({ error: 'Provider not configured' });
  if (!req.file || !/^image\/(png|jpe?g|webp)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: 'Send one PNG/JPEG/WebP image in field "file"' });
  }
  try {
    const url = await provider.uploadImage({ buffer: req.file.buffer, filename: req.file.originalname, mimetype: req.file.mimetype });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: err.message, kind: err.kind });
  }
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: queue.listJobs(), queue: queue.getQueueState() });
});

// Step 2: enqueue { provider, prompt, duration, resolution, aspectRatio, count, imageUrls }.
app.post('/api/jobs', (req, res) => {
  const { spec, error } = validateJob(getProvider(req.body?.provider), req.body || {});
  if (error) return res.status(400).json({ error });
  const usage = getUsage();
  if (spec.count > usage.remaining) {
    return res.status(400).json({ error: `Only ${usage.remaining} generations left under MAX_GENERATIONS_TOTAL=${usage.limit}` });
  }
  res.status(201).json({ ids: queue.enqueue(spec) });
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
