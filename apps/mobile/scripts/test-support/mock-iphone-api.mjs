const root = 'http://127.0.0.1:18010/api/v1';
let token = '';
async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(root + path, { ...options, headers });
  if (!response.ok) throw new Error(`test server ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
export async function login() { const result = await request('/mobile/auth/login', { method: 'POST', body: JSON.stringify({ login: 'test-owner', password: 'violetta-test-2026' }) }); token = result.access_token; return result.user; }
export async function restoreSession() { return { user: await request('/mobile/auth/me') }; }
export async function listWorkspaces() { return request('/workspaces'); }
export async function createWorkspace(name) { return request('/workspaces', { method: 'POST', body: JSON.stringify({ display_name: name, kind: 'private' }) }); }
export async function allowBackgroundAccessToSession() {}
export async function authorizedSource(path) { return { uri: root + path, headers: { Authorization: `Bearer ${token}` } }; }
export function iphoneImportStatus(workspace, key) { return request(`/media/ios-import/status?workspace_id=${encodeURIComponent(workspace)}`, { headers: { 'X-Ios-Import-Key': key } }); }
export function iphoneImportProgress(workspace, key, total) { return request(`/media/ios-import/progress?workspace_id=${encodeURIComponent(workspace)}&total=${total}`, { headers: { 'X-Ios-Import-Key': key } }); }
export function finishIphoneImport(workspace, key, total) { return request(`/media/ios-import/complete?workspace_id=${encodeURIComponent(workspace)}&total=${total}`, { method: 'POST', headers: { 'X-Ios-Import-Key': key } }); }
export async function listMedia(workspace) { return request(`/media?workspace_id=${encodeURIComponent(workspace)}`); }
