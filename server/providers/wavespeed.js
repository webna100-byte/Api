// WaveSpeedAI adapter.
// Docs checked 2026-11-09:
//   https://wavespeed.ai/docs/docs-api/bytedance/bytedance-seedance-2.0-reference-to-video
//   https://wavespeed.ai/docs/docs-api/bytedance/bytedance-seedance-2.0-image-to-video
// Submit:  POST {base}/{model-path}            -> data.id
// Status:  GET  {base}/predictions/{id}/result -> data.status, data.outputs[]
// Status values: completed | failed | cancelled | timeout | deleted | (anything else = running)
// NOTE: WaveSpeed's own article says 1080p is paid and free credit is ~720p.
// Their pricing page (Seedance 2.0): 480p $0.60/5s, 720p x2, 1080p x5.
import { env } from '../config.js';
import { requestJson, requireKey, ProviderError } from './http.js';

const provider = {
  id: 'wavespeed',
  label: 'WaveSpeedAI',
  envKey: 'WAVESPEED_API_KEY',
  baseUrl: env('WAVESPEED_BASE_URL', 'https://api.wavespeed.ai/api/v3'),
  // Used when reference images are attached.
  model: env('WAVESPEED_MODEL', 'bytedance/seedance-2.0/reference-to-video'),
  // Used for pure text prompts.
  modelText: env('WAVESPEED_MODEL_TEXT', 'bytedance/seedance-2.0/text-to-video'),
  capabilities: {
    minDuration: 4,
    maxDuration: 15,
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    maxImages: 5,
  },

  isConfigured() {
    return Boolean(process.env[this.envKey]);
  },

  /** Upload a local image so the model can fetch it by URL. */
  async uploadImage({ buffer, filename, mimetype }) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimetype }), filename);
    const res = await requestJson(`${this.baseUrl}/media/upload/binary`, {
      apiKey: requireKey(this), method: 'POST', form,
    });
    const url = res?.data?.download_url || res?.data?.url;
    if (!url) throw new ProviderError('WaveSpeed upload returned no URL', 'server');
    return url;
  },

  async createTask({ prompt, imageUrls, duration, resolution, aspectRatio }) {
    const hasImages = imageUrls.length > 0;
    const body = {
      prompt,
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: env('GENERATE_AUDIO', 'true') !== 'false',
    };
    if (hasImages) body.reference_images = imageUrls;
    const modelPath = hasImages ? this.model : this.modelText;
    const res = await requestJson(`${this.baseUrl}/${modelPath}`, {
      apiKey: requireKey(this), method: 'POST', json: body,
    });
    const id = res?.data?.id;
    if (!id) throw new ProviderError('WaveSpeed returned no task id', 'server');
    return { taskId: id, model: modelPath };
  },

  async getStatus(taskId) {
    const res = await requestJson(`${this.baseUrl}/predictions/${encodeURIComponent(taskId)}/result`, {
      apiKey: requireKey(this),
    });
    const d = res?.data || {};
    if (d.status === 'completed') {
      return { status: 'succeeded', videoUrl: d.outputs?.[0] };
    }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(d.status)) {
      return { status: 'failed', error: d.error || d.status };
    }
    return { status: 'running', raw: d.status };
  },

  async getResult(taskId) {
    const s = await this.getStatus(taskId);
    if (s.status !== 'succeeded' || !s.videoUrl) throw new ProviderError('Result not ready', 'task_failed');
    return s.videoUrl;
  },

  /** Remaining account balance in USD, or null if unavailable. */
  async getBalance() {
    try {
      const res = await requestJson(`${this.baseUrl}/balance`, { apiKey: requireKey(this), timeoutMs: 10_000 });
      const b = res?.data?.balance ?? res?.balance;
      return typeof b === 'number' ? { amount: b, unit: 'USD' } : null;
    } catch {
      return null;
    }
  },
};

export default provider;
