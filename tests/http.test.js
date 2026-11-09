import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../server/providers/http.js';

test('402 and balance messages are credit errors', () => {
  assert.equal(classifyError(402, ''), 'credit');
  assert.equal(classifyError(400, 'Insufficient balance, please top up'), 'credit');
  assert.equal(classifyError(403, 'quota exceeded'), 'credit');
});

test('other statuses', () => {
  assert.equal(classifyError(401, 'bad key'), 'auth');
  assert.equal(classifyError(429, 'slow down'), 'rate');
  assert.equal(classifyError(400, 'missing prompt'), 'bad_request');
  assert.equal(classifyError(503, ''), 'server');
});
