// Template for a new provider adapter. Copy to <name>.js, fill in, then
// register it in ./index.js. Before relying on a provider, check its
// official page: free credit amount, max free resolution/duration,
// watermark, and whether it asks for a card. If it asks for a card: skip it.
import { env } from '../config.js';
import { requestJson, requireKey, ProviderError } from './http.js';

const provider = {
  id: 'example',
  label: 'Example Provider',
  envKey: 'EXAMPLE_API_KEY',
  baseUrl: env('EXAMPLE_BASE_URL', 'https://api.example.com/v1'),
  model: env('EXAMPLE_MODEL', 'model-with-images'),
  modelText: env('EXAMPLE_MODEL_TEXT', 'model-text-only'),
  capabilities: {
    minDuration: 4,
    maxDuration: 10,
    resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    maxImages: 5,
  },

  isConfigured() {
    return Boolean(process.env[this.envKey]);
  },

  // Return a public URL the provider can download the image from.
  async uploadImage({ buffer, filename, mimetype }) {
    void buffer; void filename; void mimetype;
    throw new ProviderError('uploadImage not implemented', 'config');
  },

  // Return { taskId, model }.
  async createTask({ prompt, imageUrls, duration, resolution, aspectRatio }) {
    const res = await requestJson(`${this.baseUrl}/videos`, {
      apiKey: requireKey(this),
      method: 'POST',
      json: { model: imageUrls.length ? this.model : this.modelText, prompt, images: imageUrls, duration, resolution, aspect_ratio: aspectRatio },
    });
    return { taskId: res.id, model: this.model };
  },

  // Return { status: 'running' } | { status: 'succeeded', videoUrl } | { status: 'failed', error }.
  async getStatus(taskId) {
    const res = await requestJson(`${this.baseUrl}/videos/${taskId}`, { apiKey: requireKey(this) });
    if (res.status === 'succeeded') return { status: 'succeeded', videoUrl: res.video_url };
    if (res.status === 'failed') return { status: 'failed', error: res.error };
    return { status: 'running' };
  },

  async getResult(taskId) {
    const s = await this.getStatus(taskId);
    if (s.status !== 'succeeded') throw new ProviderError('Result not ready', 'task_failed');
    return s.videoUrl;
  },

  // Return { amount, unit } or null if the provider has no balance endpoint.
  async getBalance() {
    return null;
  },
};

export default provider;
