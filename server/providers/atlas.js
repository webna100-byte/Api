// Atlas Cloud adapter. Runtime-agnostic (Node and Cloudflare Workers).
// Docs checked 2026-11-09:
//   https://www.atlascloud.ai/docs/models/video
//   https://www.atlascloud.ai/models/bytedance/seedance-2.0/text-to-video/llms.txt
//   https://www.atlascloud.ai/docs/errors  (402 = insufficient balance)
// Submit:  POST {base}/generateVideo        body {model, prompt, ...} -> data.id
// Status:  GET  {base}/prediction/{id}      -> data.status, data.outputs[0]
// Upload:  POST {base}/uploadMedia (multipart "file") -> url
// UNVERIFIED: the reference-images field name / reference model id. The text-
// to-video page only lists `reference_images` as an example field. Check the
// model playground before relying on it, then set ATLAS_MODEL_REF.
import { requestJson, requireKey, ProviderError, envOf } from './http.js';

export default function createAtlas(env) {
  const get = envOf(env);
  return {
    id: 'atlas',
    label: 'Atlas Cloud',
    envKey: 'ATLAS_API_KEY',
    env,
    baseUrl: get('ATLAS_BASE_URL', 'https://api.atlascloud.ai/api/v1/model'),
    model: get('ATLAS_MODEL_REF', 'bytedance/seedance-2.0/reference-to-video'),
    modelText: get('ATLAS_MODEL', 'bytedance/seedance-2.0/text-to-video'),
    capabilities: {
      minDuration: 4,
      maxDuration: 15,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'],
      maxImages: 5,
    },

    isConfigured() {
      return Boolean(get(this.envKey));
    },

    uploadEndpoint() {
      return `${this.baseUrl}/uploadMedia`;
    },

    parseUpload(res) {
      const url = res?.url || res?.data?.url || res?.data?.download_url;
      if (!url) throw new ProviderError('Atlas upload returned no URL', 'server');
      return url;
    },

    async uploadImage({ buffer, filename, mimetype }) {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimetype }), filename);
      const res = await requestJson(this.uploadEndpoint(), { apiKey: requireKey(this), method: 'POST', form });
      return this.parseUpload(res);
    },

    async createTask({ prompt, imageUrls, duration, resolution, aspectRatio }) {
      const hasImages = imageUrls.length > 0;
      const model = hasImages ? this.model : this.modelText;
      const body = {
        model,
        prompt,
        duration,
        resolution,
        ratio: aspectRatio,
        generate_audio: get('GENERATE_AUDIO', 'true') !== 'false',
        watermark: false,
      };
      if (hasImages) body.reference_images = imageUrls;
      const res = await requestJson(`${this.baseUrl}/generateVideo`, {
        apiKey: requireKey(this), method: 'POST', json: body,
      });
      const id = res?.data?.id;
      if (!id) throw new ProviderError('Atlas returned no prediction id', 'server');
      return { taskId: id, model };
    },

    async getStatus(taskId) {
      const res = await requestJson(`${this.baseUrl}/prediction/${encodeURIComponent(taskId)}`, {
        apiKey: requireKey(this),
      });
      const d = res?.data || {};
      if (d.status === 'completed' || d.status === 'succeeded') return { status: 'succeeded', videoUrl: d.outputs?.[0] };
      if (['failed', 'cancelled', 'canceled', 'timeout'].includes(d.status)) {
        return { status: 'failed', error: d.error || d.status };
      }
      return { status: 'running', raw: d.status };
    },

    async getResult(taskId) {
      const s = await this.getStatus(taskId);
      if (s.status !== 'succeeded' || !s.videoUrl) throw new ProviderError('Result not ready', 'task_failed');
      return s.videoUrl;
    },

    // No documented balance endpoint for API keys.
    async getBalance() {
      return null;
    },
  };
}
