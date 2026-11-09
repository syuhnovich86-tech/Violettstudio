import { readFile } from 'node:fs/promises';

const apiRoot = (process.env.VIOLETTA_TEST_API_URL ?? 'http://127.0.0.1:18000/api/v1').replace(/\/$/, '');
const loginName = process.env.VIOLETTA_TEST_LOGIN ?? 'test-owner';
const password = process.env.VIOLETTA_TEST_PASSWORD ?? 'violetta-test-2026';

let token = '';

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiRoot}${path}`, { ...options, headers });
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

const login = await request('/mobile/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: loginName, password }),
});
token = login.access_token;

const workspaces = await request('/workspaces');
const workspace = workspaces.find((item) => item.kind === 'studio') ?? workspaces[0];
if (!workspace) throw new Error('No workspace is available for UI test data.');

const png = await readFile(new URL('../assets/violetta-emblem-circle-v3.png', import.meta.url));
const batch = await request('/media/batches', {
  method: 'POST',
  body: JSON.stringify({ workspace_id: workspace.id, comment: 'Данные для проверки Android' }),
}, [201]);
const form = new FormData();
form.append('upload', new Blob([png], { type: 'image/png' }), 'violetta-ui-test.png');
const media = await request(`/media?workspace_id=${encodeURIComponent(workspace.id)}&publication_allowed=true&batch_id=${encodeURIComponent(batch.id)}`, {
  method: 'POST',
  body: form,
}, [201]);
await request(`/media/${media.id}/comment`, {
  method: 'PUT',
  body: JSON.stringify({ comment: 'Реальное фото на тестовом сервере' }),
});
await request(`/media/${media.id}/content-mark`, {
  method: 'PUT',
  body: JSON.stringify({ content_marked: true }),
});

const participants = await request('/discussions/participants');
const member = participants.find((item) => item.id !== login.user.id);
const discussion = await request('/discussions', {
  method: 'POST',
  body: JSON.stringify({ title: 'Проверка Android', member_ids: member ? [member.id] : [] }),
}, [201]);
await request(`/discussions/${discussion.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({
    body: 'Это реальное сообщение с вложением из медиатеки.',
    attachments: [{ media_id: media.id }],
  }),
}, [201]);

const scheduled = new Date();
scheduled.setUTCDate(scheduled.getUTCDate() + 1);
scheduled.setUTCHours(12, 0, 0, 0);
await request('/content/items', {
  method: 'POST',
  body: JSON.stringify({
    title: 'Пост из Android',
    caption: 'Реальный элемент контент-плана для проверки приложения',
    editor_instruction: 'Проверить карточку, статусы и медиатеку',
    scheduled_at: scheduled.toISOString(),
    platforms: ['telegram'],
    media_ids: [media.id],
    content_format: 'post',
    media_limit: 1,
  }),
}, [201]);

console.log(JSON.stringify({ login: loginName, password, workspace: workspace.name, media_id: media.id, discussion_id: discussion.id }, null, 2));
