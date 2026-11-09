// Shared HTTP helper for provider adapters: auth header, JSON parsing and
// classification of errors so the queue can tell "out of credit" apart from
// everything else.

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {'credit'|'auth'|'rate'|'bad_request'|'not_found'|'server'|'network'|'task_failed'|'config'} kind
   * @param {number} [status]
   */
  constructor(message, kind, status) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

const CREDIT_PATTERN = /insufficient|balance|credit|quota|top.?up|recharge|payment|billing|余额|not enough/i;

export function classifyError(status, message = '') {
  if (status === 402 || CREDIT_PATTERN.test(message)) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server';
}

function extractMessage(body, fallback) {
  if (!body || typeof body !== 'object') return String(body || fallback);
  return (
    body.message || body.msg || body.error?.message || body.error ||
    body.data?.error || body.detail || fallback
  );
}

/**
 * fetch wrapper. Returns parsed JSON. Throws ProviderError on HTTP errors
 * and on 200 responses whose body carries a non-200 "code" field
 * (both WaveSpeed and Atlas wrap responses as {code, message, data}).
 */
export async function requestJson(url, { apiKey, method = 'GET', json, form, timeoutMs = 60_000 } = {}) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets the multipart boundary itself
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderError(`Network error calling ${new URL(url).host}: ${err.message}`, 'network');
  }

  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }

  if (!res.ok) {
    const msg = extractMessage(parsed, res.statusText);
    throw new ProviderError(`HTTP ${res.status}: ${msg}`, classifyError(res.status, msg), res.status);
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.code === 'number' && parsed.code !== 200 && parsed.code !== 0) {
    const msg = extractMessage(parsed, `code ${parsed.code}`);
    throw new ProviderError(`API code ${parsed.code}: ${msg}`, classifyError(parsed.code, msg), parsed.code);
  }
  return parsed;
}

export function requireKey(provider) {
  const key = process.env[provider.envKey];
  if (!key) throw new ProviderError(`${provider.envKey} is not set in .env`, 'config');
  return key;
}
