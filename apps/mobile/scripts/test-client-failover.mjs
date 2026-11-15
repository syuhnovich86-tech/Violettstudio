import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
globalThis.__directPlatform = 'android';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './networkOrigin') return { url: new URL('../src/api/networkOrigin.ts', import.meta.url).href, shortCircuit: true };
  if (['react-native', 'expo-secure-store', 'expo-file-system'].includes(specifier)) {
    return { url: pathToFileURL(process.cwd() + '/scripts/test-support/direct-' + specifier + '.mjs').href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
let sends = [];
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/health')) return new Response('', {status: url.includes('sslip.io') ? 503 : 200});
  sends.push({url, method: options.method});
  throw new TypeError('Network request failed');
};
const api = await import('../src/api/client.ts');
await assert.rejects(() => api.apiRequest('/operation', {method: 'POST', body: '{}'}, true), /Нет связи/);
assert.equal(sends.length, 1, 'A failed mutation must never be replayed automatically');
assert.ok(sends[0].url.startsWith('https://31-10-64-46.sslip.io/'));
assert.equal((await api.authorizedSource('/api/v1/media/123/thumbnail')).uri, 'https://31-10-64-46.sslip.io/api/v1/media/123/thumbnail');
assert.ok(sends.every(({ url }) => !url.includes('.ts.net')), 'A failed direct request must never use Tailscale');
globalThis.fetch = async (url) => {
  assert.ok(url.startsWith('https://31-10-64-46.sslip.io/'));
  return new Response('{"recovered":true}', { status: 200 });
};
assert.deepEqual(await api.apiRequest('/health'), { recovered: true });
console.log('Android stays on direct HTTPS after failure, never replays a mutation, and recovers on the next request');
