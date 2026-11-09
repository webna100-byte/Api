import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJob } from '../server/validate.js';
import createWavespeed from '../server/providers/wavespeed.js';

const ws = createWavespeed({ WAVESPEED_API_KEY: 'k' });
const ok = { prompt: 'sea', duration: '5', resolution: '480p', aspectRatio: '16:9', count: '2', imageUrls: [] };

test('accepts a valid job', () => {
  const { spec, error } = validateJob(ws, ok);
  assert.equal(error, undefined);
  assert.equal(spec.duration, 5);
  assert.equal(spec.count, 2);
});

test('rejects bad input', () => {
  assert.match(validateJob(createWavespeed({}), ok).error, /not configured/);
  assert.match(validateJob(ws, { ...ok, duration: 20 }).error, /4–15/);
  assert.match(validateJob(ws, { ...ok, duration: 25 }).error, /بين 1 و 20/);
  assert.equal(validateJob(createWavespeed({ WAVESPEED_API_KEY: 'k', WAVESPEED_MAX_DURATION: '20' }), { ...ok, duration: 20 }).error, undefined);
  assert.match(validateJob(ws, { ...ok, resolution: '8k' }).error, /Resolution/);
  assert.match(validateJob(ws, { ...ok, imageUrls: Array(6).fill('https://x/y.png') }).error, /Max 5/);
  assert.match(validateJob(ws, { ...ok, imageUrls: ['file:///etc/passwd'] }).error, /Invalid image/);
});
