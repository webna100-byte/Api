// Shared request validation (used by the Node server and the Cloudflare worker).

export const MAX_IMAGES = 5;
export const MAX_BATCH = 20;

/**
 * @returns {{ spec?: object, error?: string }}
 */
export function validateJob(provider, body) {
  if (!provider) return { error: 'Unknown provider' };
  if (!provider.isConfigured()) return { error: `${provider.label} is not configured (set ${provider.envKey})` };

  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { error: 'Prompt is required' };
  if (prompt.length > 5000) return { error: 'Prompt is too long' };

  const cap = provider.capabilities;
  const duration = Number.parseInt(body.duration, 10);
  if (!(duration >= cap.minDuration && duration <= cap.maxDuration)) {
    return { error: `Duration must be ${cap.minDuration}-${cap.maxDuration}s for ${provider.label}. For longer videos, generate clips and stitch them.` };
  }
  const resolution = String(body.resolution);
  if (!cap.resolutions.includes(resolution)) return { error: `Resolution must be one of ${cap.resolutions.join(', ')}` };
  const aspectRatio = String(body.aspectRatio);
  if (!cap.aspectRatios.includes(aspectRatio)) return { error: `Aspect ratio must be one of ${cap.aspectRatios.join(', ')}` };

  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [];
  const maxImg = Math.min(MAX_IMAGES, cap.maxImages);
  if (imageUrls.length > maxImg) return { error: `Max ${maxImg} images` };
  if (imageUrls.some((u) => !/^(https?|mock|asset):\/\//.test(u))) return { error: 'Invalid image URL' };

  const count = Math.min(Math.max(Number.parseInt(body.count, 10) || 1, 1), MAX_BATCH);
  return { spec: { provider: provider.id, prompt, duration, resolution, aspectRatio, imageUrls, count } };
}

export function publicProviders(providers) {
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured(),
    envKey: p.envKey,
    model: p.model,
    modelText: p.modelText,
    capabilities: p.capabilities,
  }));
}
