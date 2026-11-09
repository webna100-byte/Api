// Provider registry for the Node server. To add a provider: copy
// _template.js, fill it in, and add it here (and in cloudflare/src/worker.js
// if it should run on Cloudflare too).
import createWavespeed from './wavespeed.js';
import createAtlas from './atlas.js';
import mock from './mock.js';
import { publicProviders } from '../validate.js';

const providers = [createWavespeed(process.env), createAtlas(process.env), mock];

export function getProvider(id) {
  return providers.find((p) => p.id === id);
}

export function listProviders() {
  return publicProviders(providers);
}
