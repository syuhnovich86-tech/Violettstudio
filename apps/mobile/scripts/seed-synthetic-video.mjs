import { readFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:18010/api/v1';
const response = await fetch(`${base}/mobile/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'iossim', password: 'a' }) });
if (!response.ok) throw new Error(`Test login failed: ${response.status}`);
const { access_token } = await response.json();
const headers = { Authorization: `Bearer ${access_token}` };
const folders = await (await fetch(`${base}/workspaces`, { headers })).json();
const folder = folders.find((entry) => entry.display_name === 'Simulator Photos');
if (!folder) throw new Error('Isolated test folder missing');
const form = new FormData();
form.append('upload', new Blob([await readFile(process.argv[2])], { type: 'video/mp4' }), 'synthetic-test.mp4');
const upload = await fetch(`${base}/media?workspace_id=${folder.id}`, { method: 'POST', headers, body: form });
if (!upload.ok) throw new Error(`Test upload failed: ${upload.status} ${await upload.text()}`);
const item = await upload.json();
console.log(JSON.stringify({ id: item.id, workspace: folder.display_name, media_type: item.media_type }));
