const apiRoot = (process.env.VIOLETTA_TEST_API_URL ?? 'http://127.0.0.1:18000/api/v1').replace(/\/$/, '');
const loginName = process.env.VIOLETTA_TEST_LOGIN ?? 'violetta';
const password = process.env.VIOLETTA_TEST_PASSWORD ?? 'violetta-test-2026';

const loginResponse = await fetch(`${apiRoot}/mobile/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: loginName, password }),
});
if (!loginResponse.ok) throw new Error(`mobile login failed: ${loginResponse.status}`);
const session = await loginResponse.json();
if (!session.user?.can_import_ios_photo_library) throw new Error('test user has no iOS import permission');

const headers = { Authorization: `Bearer ${session.access_token}` };
const workspacesResponse = await fetch(`${apiRoot}/workspaces`, { headers });
if (!workspacesResponse.ok) throw new Error(`workspaces failed: ${workspacesResponse.status}`);
const workspaces = await workspacesResponse.json();
if (!workspaces.some((workspace) => workspace.display_name === 'Фото с iPhone')) {
  throw new Error('server folder “Фото с iPhone” is missing');
}

const logoutResponse = await fetch(`${apiRoot}/mobile/auth/logout`, { method: 'POST', headers });
if (!logoutResponse.ok) throw new Error(`mobile logout failed: ${logoutResponse.status}`);
console.log(`API smoke passed for ${loginName}; workspaces: ${workspaces.length}`);
