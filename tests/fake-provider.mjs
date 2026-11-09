// Fake WaveSpeed-compatible API for end-to-end tests without spending credit.
// Usage: node tests/fake-provider.mjs [port=4010] [creditFailAfter=0] [video.mp4]
// Then point WAVESPEED_BASE_URL at http://127.0.0.1:<port>/api/v3
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 4010);
const failAfter = Number(process.argv[3] || 0);
const videoFile = process.argv[4];
const tasks = new Map();
let submitted = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.headers.authorization !== 'Bearer test-key' && !url.pathname.startsWith('/files/')) {
    return send(res, 401, { code: 401, message: 'Invalid API key' });
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && url.pathname === '/api/v3/media/upload/binary') {
      if (!String(req.headers['content-type']).startsWith('multipart/form-data') || !body.includes('name="file"')) {
        return send(res, 400, { code: 400, message: 'file field required' });
      }
      return send(res, 200, { code: 200, data: { download_url: `http://127.0.0.1:${port}/files/${crypto.randomUUID()}.png` } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/balance') {
      return send(res, 200, { code: 200, data: { balance: failAfter ? Math.max(0, failAfter - submitted) * 0.6 : 1 } });
    }
    const result = url.pathname.match(/^\/api\/v3\/predictions\/([\w-]+)\/result$/);
    if (req.method === 'GET' && result) {
      const t = tasks.get(result[1]);
      if (!t) return send(res, 404, { code: 404, message: 'not found' });
      const done = Date.now() - t.at > 1500;
      return send(res, 200, { code: 200, data: { id: result[1], status: done ? 'completed' : 'processing', outputs: done ? [`http://127.0.0.1:${port}/files/${result[1]}.mp4`] : [] } });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/') && url.pathname.endsWith('.mp4')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return videoFile ? fs.createReadStream(videoFile).pipe(res) : res.end(Buffer.alloc(1024));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/v3/bytedance/')) {
      submitted += 1;
      if (failAfter && submitted > failAfter) return send(res, 402, { code: 402, message: 'Insufficient balance' });
      const json = JSON.parse(body.toString() || '{}');
      if (!json.prompt) return send(res, 400, { code: 400, message: 'prompt required' });
      const id = crypto.randomUUID();
      tasks.set(id, { at: Date.now(), json });
      console.log(`[fake] task ${id} ${url.pathname} ${JSON.stringify(json)}`);
      return send(res, 200, { code: 200, data: { id, status: 'created' } });
    }
    send(res, 404, { code: 404, message: `no route ${req.method} ${url.pathname}` });
  });
}).listen(port, '127.0.0.1', () => console.log(`fake provider on ${port}, creditFailAfter=${failAfter}`));
