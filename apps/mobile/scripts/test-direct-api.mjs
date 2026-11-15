import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const platform = process.argv[2];
globalThis.__directPlatform = platform;
process.env.EXPO_PUBLIC_API_URL = 'https://vita29.taild51e5c.ts.net/api/v1';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './networkOrigin') return { url: new URL('../src/api/networkOrigin.ts', import.meta.url).href, shortCircuit: true };
  if (['react-native', 'expo-secure-store', 'expo-file-system'].includes(specifier)) {
    return { url: pathToFileURL(process.cwd() + '/scripts/test-support/direct-' + specifier + '.mjs').href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
let request;
globalThis.fetch = async (url, options) => { request = {url, options}; return new Response('{"ok":true}', {status: 200}); };
const api = await import('../src/api/client.ts');
const root = platform === 'android' ? 'https://31-10-64-46.sslip.io/api/v1' : 'https://vita29.taild51e5c.ts.net/api/v1';
assert.equal(api.API_ROOT, root);
assert.equal(api.apiUrl('/api/v1/media'), root + '/media');
assert.equal(api.apiUrl('/media'), root + '/media');
assert.deepEqual(await api.apiRequest('/health'), {ok: true});
assert.equal(request.url, root + '/health');
assert.equal(request.options.headers.get('Authorization'), 'Bearer synthetic-token');
assert.equal((await api.authorizedSource('/api/v1/media/123/thumbnail')).uri, root + '/media/123/thumbnail');
const legacyMedia = 'https://vita29.taild51e5c.ts.net/api/v1/media/123/thumbnail?size=small';
assert.equal((await api.authorizedSource(legacyMedia)).uri, root + '/media/123/thumbnail?size=small');
assert.equal(api.apiUrl('https://example.com/image.jpg'), 'https://example.com/image.jpg');
assert.equal(api.apiUrl('https://vita29.taild51e5c.ts.net.evil.example/api/v1/media'), 'https://vita29.taild51e5c.ts.net.evil.example/api/v1/media');
console.log(platform + ' API requests and media use expected HTTPS origin');
