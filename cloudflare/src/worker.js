// Cloudflare Worker: same JSON API as the local Node server (server/index.js),
// running on the Workers Free plan (no card).
//  - The UI in ../public is bundled into the Worker (build-assets.mjs).
//  - API keys live in Worker secrets, never in the browser.
//  - The queue, usage counter and job history live in one SQLite-backed
//    Durable Object, which polls providers with alarms, so generation keeps
//    going even if the browser tab is closed.
//  - No R2/Firebase storage (both need a card): finished videos are streamed
//    from the provider URL through /api/jobs/:id/video. Those URLs expire
//    (often ~24h), so download them promptly. The UI does it automatically.
import { DurableObject } from 'cloudflare:workers';
import createWavespeed from '../../server/providers/wavespeed.js';
import createAtlas from '../../server/providers/atlas.js';
import { requestJson, ProviderError } from '../../server/providers/http.js';
import { validateJob, publicProviders, MAX_IMAGES } from '../../server/validate.js';
import STATIC from './static.generated.js';

const ACTIVE = new Set(['submitting', 'running']);
const TRANSIENT = new Set(['network', 'rate', 'server']);
const MAX_HISTORY = 200;
const MAX_UPLOAD_BYTES = 11 * 1024 * 1024;

function providersFor(env) {
  return [createWavespeed(env), createAtlas(env)];
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function authorized(request, env) {
  const url = new URL(request.url);
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') || '';
  return token !== '' && safeEqual(token, env.ACCESS_TOKEN);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname);

    // Fail closed: a public URL with provider keys must never be open.
    if (!env.ACCESS_TOKEN) return json({ error: 'ACCESS_TOKEN secret is not set on the Worker' }, 503);
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    const providers = providersFor(env);
    const stub = env.QUEUE.get(env.QUEUE.idFromName('main'));

    if (url.pathname === '/api/providers' && request.method === 'GET') {
      return json({
        providers: publicProviders(providers),
        maxImages: MAX_IMAGES,
        features: { stitch: false, auth: true, serverFiles: false },
      });
    }

    if (url.pathname === '/api/upload' && request.method === 'POST') {
      return proxyUpload(request, providers.find((p) => p.id === url.searchParams.get('provider')));
    }

    const video = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/video$/);
    if (video && request.method === 'GET') {
      const res = await stub.fetch(new Request(`https://do/api/jobs/${video[1]}`));
      if (!res.ok) return res;
      return streamVideo(await res.json(), url.searchParams.get('download') === '1');
    }

    if (url.pathname === '/api/stitch') {
      return json({ error: 'Stitching needs ffmpeg: download the clips and run the local app (npm start) to merge them.' }, 501);
    }

    // Everything else (jobs, queue, usage) is handled by the Durable Object.
    return stub.fetch(request);
  },
};

function serveStatic(pathname) {
  const file = STATIC[pathname];
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(file.body, {
    headers: { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });
}

// Streams the browser's multipart upload straight to the provider (no parsing,
// so it stays within the Free plan's CPU limit).
async function proxyUpload(request, provider) {
  if (!provider?.isConfigured()) return json({ error: 'Provider not configured' }, 400);
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('multipart/form-data')) return json({ error: 'Expected multipart/form-data with field "file"' }, 400);
  const size = Number(request.headers.get('Content-Length') || 0);
  if (!size || size > MAX_UPLOAD_BYTES) return json({ error: 'Image must be under 10 MB' }, 413);
  try {
    const res = await requestJson(provider.uploadEndpoint(), {
      apiKey: provider.env[provider.envKey], method: 'POST', raw: request.body, contentType: type,
    });
    return json({ url: provider.parseUpload(res) });
  } catch (err) {
    return json({ error: err.message, kind: err.kind }, 502);
  }
}

async function streamVideo(job, download) {
  if (!job.remoteUrl || !/^https?:\/\//.test(job.remoteUrl)) return json({ error: 'No video for this job' }, 404);
  const upstream = await fetch(job.remoteUrl);
  if (!upstream.ok) return json({ error: `Provider link returned HTTP ${upstream.status} (it may have expired)` }, 502);
  const name = `${job.provider}_${job.resolution}_${job.duration}s_${job.id.slice(0, 8)}.mp4`;
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') || 'video/mp4',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
  });
  const len = upstream.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);
  return new Response(upstream.body, { headers });
}

export class QueueDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.providers = providersFor(env);
  }

  get limit() {
    const n = Number.parseInt(this.env.MAX_GENERATIONS_TOTAL, 10);
    return Number.isFinite(n) ? n : 20;
  }

  get pollMs() {
    const n = Number.parseInt(this.env.POLL_INTERVAL_MS, 10);
    return Number.isFinite(n) && n >= 1000 ? n : 5000;
  }

  get timeoutMs() {
    const n = Number.parseInt(this.env.TASK_TIMEOUT_MS, 10);
    return Number.isFinite(n) ? n : 20 * 60 * 1000;
  }

  async load() {
    const [jobs, usage, state] = await Promise.all([
      this.ctx.storage.get('jobs'),
      this.ctx.storage.get('usage'),
      this.ctx.storage.get('state'),
    ]);
    return {
      jobs: jobs || [],
      usage: usage || { total: 0, byProvider: {} },
      state: state || { paused: false, pauseReason: null },
    };
  }

  async save(data) {
    if (data.jobs.length > MAX_HISTORY) {
      const keep = data.jobs.length - MAX_HISTORY;
      let dropped = 0;
      data.jobs = data.jobs.filter((j) => {
        if (dropped < keep && !ACTIVE.has(j.status) && j.status !== 'queued') { dropped += 1; return false; }
        return true;
      });
    }
    await this.ctx.storage.put({ jobs: data.jobs, usage: data.usage, state: data.state });
  }

  providerLimit(id) {
    const n = Number.parseInt(this.env[`${id.toUpperCase()}_MAX_GENERATIONS`], 10);
    return Number.isFinite(n) ? n : null;
  }

  usageView(usage) {
    const byProvider = {};
    for (const [id, v] of Object.entries(usage.byProvider)) byProvider[id] = { ...v, limit: this.providerLimit(id) };
    return { total: usage.total, limit: this.limit, remaining: Math.max(0, this.limit - usage.total), byProvider };
  }

  queueView(data) {
    return {
      ...data.state,
      queued: data.jobs.filter((j) => j.status === 'queued').length,
      active: data.jobs.filter((j) => ACTIVE.has(j.status)).length,
    };
  }

  async kick() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    const data = await this.load();
    const touch = (job, patch) => Object.assign(job, patch, { updatedAt: new Date().toISOString() });

    if (p === '/api/jobs' && m === 'GET') {
      return json({
        jobs: data.jobs.map((j) => ({ ...j, imageCount: j.imageUrls?.length || 0 })),
        queue: this.queueView(data),
      });
    }

    if (p === '/api/jobs' && m === 'POST') {
      const body = await request.json().catch(() => ({}));
      const provider = this.providers.find((x) => x.id === body.provider);
      const { spec, error } = validateJob(provider, body);
      if (error) return json({ error }, 400);
      const remaining = this.limit - data.usage.total;
      if (spec.count > remaining) return json({ error: `Only ${Math.max(0, remaining)} generations left under MAX_GENERATIONS_TOTAL=${this.limit}` }, 400);
      const batchId = crypto.randomUUID();
      const now = new Date().toISOString();
      const ids = [];
      for (let i = 0; i < spec.count; i += 1) {
        const { count: _c, ...rest } = spec;
        const job = { id: crypto.randomUUID(), batchId, ...rest, status: 'queued', createdAt: now, updatedAt: now };
        data.jobs.push(job);
        ids.push(job.id);
      }
      await this.save(data);
      await this.kick();
      return json({ ids }, 201);
    }

    const one = p.match(/^\/api\/jobs\/([\w-]+)$/);
    if (one && m === 'GET') {
      const job = data.jobs.find((j) => j.id === one[1]);
      return job ? json(job) : json({ error: 'not found' }, 404);
    }
    if (one && m === 'DELETE') {
      const job = data.jobs.find((j) => j.id === one[1]);
      const ok = job?.status === 'queued';
      if (ok) { touch(job, { status: 'cancelled' }); await this.save(data); }
      return json({ ok });
    }

    const retry = p.match(/^\/api\/jobs\/([\w-]+)\/retry$/);
    if (retry && m === 'POST') {
      const job = data.jobs.find((j) => j.id === retry[1]);
      const ok = Boolean(job && ['failed', 'cancelled'].includes(job.status));
      if (ok) {
        touch(job, { status: 'queued', error: null, errorKind: null, taskId: null, remoteUrl: null });
        await this.save(data);
        await this.kick();
      }
      return json({ ok });
    }

    if (p === '/api/jobs/clear-finished' && m === 'POST') {
      data.jobs = data.jobs.filter((j) => j.status === 'queued' || ACTIVE.has(j.status));
      await this.save(data);
      return json({ ok: true });
    }

    if (p === '/api/queue/resume' && m === 'POST') {
      data.state = { paused: false, pauseReason: null };
      await this.save(data);
      await this.kick();
      return json(this.queueView(data));
    }

    if (p === '/api/queue/clear' && m === 'POST') {
      let n = 0;
      for (const j of data.jobs) if (j.status === 'queued') { touch(j, { status: 'cancelled' }); n += 1; }
      await this.save(data);
      return json({ cancelled: n });
    }

    if (p === '/api/usage' && m === 'GET') {
      const balances = {};
      if (url.searchParams.get('balance') === '1') {
        await Promise.all(this.providers.filter((x) => x.isConfigured()).map(async (x) => {
          balances[x.id] = await x.getBalance().catch(() => null);
        }));
      }
      return json({ ...this.usageView(data.usage), balances });
    }

    if (p === '/api/usage/reset' && m === 'POST') {
      data.usage = { total: 0, byProvider: {} };
      await this.save(data);
      return json(this.usageView(data.usage));
    }

    return json({ error: 'not found' }, 404);
  }

  // One step of the queue per alarm: poll the in-flight task, or submit the next one.
  async alarm() {
    const data = await this.load();
    const now = () => new Date().toISOString();
    const touch = (job, patch) => Object.assign(job, patch, { updatedAt: now() });
    const fail = (job, err) => {
      const kind = err instanceof ProviderError ? err.kind : 'server';
      touch(job, { status: 'failed', errorKind: kind, error: err.message });
      if (kind === 'credit') data.state = { paused: true, pauseReason: `Out of credit on ${job.provider}: ${err.message}` };
      if (kind === 'auth') data.state = { paused: true, pauseReason: `API key rejected by ${job.provider}: ${err.message}` };
    };
    let next = null; // ms until next alarm, null = idle

    // Anything stuck in "submitting" (crash mid-request) is unknown: don't resubmit, flag it.
    for (const j of data.jobs) {
      if (j.status === 'submitting' && Date.now() - Date.parse(j.updatedAt) > 120_000) {
        touch(j, { status: 'failed', errorKind: 'server', error: 'Submission interrupted; check the provider dashboard before retrying.' });
      }
    }

    const inflight = data.jobs.find((j) => j.status === 'running' && j.taskId);
    if (inflight) {
      const provider = this.providers.find((x) => x.id === inflight.provider);
      try {
        if (Date.now() - Date.parse(inflight.submittedAt) > this.timeoutMs) {
          throw new ProviderError(`Timed out (task ${inflight.taskId} may still finish on the provider side)`, 'task_failed');
        }
        const s = await provider.getStatus(inflight.taskId);
        if (s.status === 'succeeded') {
          if (!s.videoUrl) throw new ProviderError('Task succeeded but returned no video URL', 'task_failed');
          touch(inflight, { status: 'succeeded', remoteUrl: s.videoUrl, finishedAt: now(), file: null });
          next = 100;
        } else if (s.status === 'failed') {
          throw new ProviderError(String(s.error || 'Generation failed'), 'task_failed');
        } else {
          if (s.raw) inflight.providerStatus = s.raw;
          next = this.pollMs;
        }
      } catch (err) {
        if (err instanceof ProviderError && TRANSIENT.has(err.kind)) next = this.pollMs * 2;
        else { fail(inflight, err); next = 100; }
      }
    } else if (!data.state.paused) {
      const job = data.jobs.find((j) => j.status === 'queued');
      if (job) {
        const provider = this.providers.find((x) => x.id === job.provider);
        const lim = this.providerLimit(job.provider);
        const used = data.usage.byProvider[job.provider]?.count || 0;
        if (!provider?.isConfigured()) {
          touch(job, { status: 'failed', errorKind: 'config', error: `Provider "${job.provider}" is not configured` });
          next = 100;
        } else if (data.usage.total >= this.limit) {
          data.state = { paused: true, pauseReason: `Total generation limit reached (${this.limit}). Raise MAX_GENERATIONS_TOTAL to continue.` };
        } else if (lim !== null && used >= lim) {
          data.state = { paused: true, pauseReason: `${job.provider} limit reached (${lim}).` };
        } else {
          touch(job, { status: 'submitting' });
          await this.save(data); // record intent before the billable call
          try {
            // Never auto-retry: a retry after an unclear failure can create a second billed task.
            const { taskId, model } = await provider.createTask({
              prompt: job.prompt,
              imageUrls: job.imageUrls || [],
              duration: job.duration,
              resolution: job.resolution,
              aspectRatio: job.aspectRatio,
            });
            data.usage.total += 1;
            const u = (data.usage.byProvider[job.provider] ||= { count: 0, seconds: 0, byResolution: {} });
            u.count += 1;
            u.seconds += job.duration;
            u.byResolution[job.resolution] = (u.byResolution[job.resolution] || 0) + 1;
            touch(job, { status: 'running', taskId, model, submittedAt: now() });
            next = this.pollMs;
          } catch (err) {
            fail(job, err);
            next = 100;
          }
        }
      }
    }

    await this.save(data);
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
  }
}
