// Provider registry. To add a provider: copy _template.js, fill it in,
// and add it to this list. Nothing else in the app needs to change.
import wavespeed from './wavespeed.js';
import atlas from './atlas.js';
import mock from './mock.js';

const providers = [wavespeed, atlas, mock];

export function getProvider(id) {
  return providers.find((p) => p.id === id);
}

export function listProviders() {
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
