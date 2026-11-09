const apiRoot = (process.env.VIOLETTA_TEST_API_URL ?? 'http://127.0.0.1:18000/api/v1').replace(/\/$/, '');
const loginName = process.env.VIOLETTA_TEST_LOGIN ?? 'test-owner';
const password = process.env.VIOLETTA_TEST_PASSWORD ?? 'violetta-test-2026';

let token = '';
let mediaId = '';
let discussionId = '';
let contentId = '';
const passed = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiRoot}${path}`, { ...options, headers });
  if (!expected.includes(response.status)) {
    const body = await response.text();
    throw new Error(`${options.method ?? 'GET'} ${path}: expected ${expected.join('/')}, got ${response.status}: ${body}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}
function ok(label) { passed.push(label); console.log(`✓ ${label}`); }
function monday(value) { const date = new Date(value); const day = (date.getUTCDay() + 6) % 7; date.setUTCDate(date.getUTCDate() - day); return date.toISOString().slice(0, 10); }

try {
  const login = await request('/mobile/auth/login', { method: 'POST', body: JSON.stringify({ login: loginName, password }) });
  token = login.access_token;
  assert(login.user.role === 'owner' && login.user.can_access_admin && login.user.can_access_chats && login.user.can_access_content, 'owner permissions are incomplete');
  const me = await request('/mobile/auth/me');
  assert(me.id === login.user.id, 'restored mobile identity differs');
  ok('mobile login and bearer session');

  const storage = await request('/storage');
  assert(storage.total_bytes > 0 && storage.free_bytes >= 0, 'invalid storage response');
  const workspaces = await request('/workspaces');
  assert(Array.isArray(workspaces) && workspaces.length > 0, 'no workspaces returned');
  const workspace = workspaces.find((item) => item.kind === 'studio') ?? workspaces[0];
  ok('storage and server folders');

  const png = await readFile(new URL('../assets/violetta-emblem-circle-v3.png', import.meta.url));
  const form = new FormData();
  form.append('upload', new Blob([png], { type: 'image/png' }), `mobile-regression-${Date.now()}.png`);
  const batch = await request('/media/batches', { method: 'POST', body: JSON.stringify({ workspace_id: workspace.id, comment: 'Android regression upload' }) }, [201]);
  const uploaded = await request(`/media?workspace_id=${encodeURIComponent(workspace.id)}&publication_allowed=false&batch_id=${encodeURIComponent(batch.id)}`, { method: 'POST', body: form }, [201]);
  mediaId = uploaded.id;
  const media = await request(`/media?workspace_id=${encodeURIComponent(workspace.id)}&limit=100&offset=0`);
  assert(media.some((item) => item.id === mediaId), 'uploaded media not returned by archive');
  const thumbnail = await fetch(`${apiRoot}/media/${mediaId}/thumbnail`, { headers: { Authorization: `Bearer ${token}` } });
  assert(thumbnail.ok && (thumbnail.headers.get('content-type') ?? '').startsWith('image/'), 'thumbnail is not readable with bearer auth');
  await request(`/media/${mediaId}/comment`, { method: 'PUT', body: JSON.stringify({ comment: 'Проверено Android regression' }) });
  await request(`/media/${mediaId}/publication`, { method: 'PUT', body: JSON.stringify({ publication_allowed: true }) });
  await request(`/media/${mediaId}/content-mark`, { method: 'PUT', body: JSON.stringify({ content_marked: true }) });
  ok('upload, archive, preview, comment and media flags');

  const now = new Date();
  const startDate = new Date(now); startDate.setUTCDate(now.getUTCDate() - 31);
  const endDate = new Date(now); endDate.setUTCDate(now.getUTCDate() + 31);
  const calendarUsers = await request('/yclients/calendar-users');
  const visits = await request(`/yclients/visits?start_date=${startDate.toISOString().slice(0, 10)}&end_date=${endDate.toISOString().slice(0, 10)}`);
  assert(Array.isArray(calendarUsers) && Array.isArray(visits), 'calendar endpoints returned invalid data');
  ok('calendar users and visits');

  const participants = await request('/discussions/participants');
  const member = participants.find((item) => item.id !== me.id);
  const discussion = await request('/discussions', { method: 'POST', body: JSON.stringify({ title: `Android regression ${Date.now()}`, member_ids: member ? [member.id] : [] }) }, [201]);
  discussionId = discussion.id;
  const sent = await request(`/discussions/${discussionId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Проверка реального чата Android', attachments: [{ media_id: mediaId }] }) }, [201]);
  assert(sent.attachments.some((item) => item.media_id === mediaId), 'chat attachment missing');
  await request(`/discussions/${discussionId}/messages/${sent.id}/like`, { method: 'PUT' });
  await request(`/discussions/${discussionId}/messages/${sent.id}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '👍' }) });
  const messages = await request(`/discussions/${discussionId}/messages`);
  assert(messages.some((item) => item.id === sent.id), 'sent message missing');
  await request(`/discussions/${discussionId}/read`, { method: 'PUT', body: JSON.stringify({ message_id: sent.id }) }, [204]);
  await request('/discussions/notifications/inbox');
  ok('real chat, attachment, reaction, like and read state');

  const scheduled = new Date(); scheduled.setUTCHours(12, 0, 0, 0); scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  const content = await request('/content/items', { method: 'POST', body: JSON.stringify({ title: 'Android regression content', caption: 'Тестовая подпись', editor_instruction: 'Проверка приложения', scheduled_at: scheduled.toISOString(), platforms: ['telegram'], media_ids: [mediaId], content_format: 'post', media_limit: 1 }) }, [201]);
  contentId = content.id;
  const contentList = await request(`/content/items?week_start=${monday(scheduled)}`);
  assert(contentList.some((item) => item.id === contentId), 'content item missing from week');
  await request(`/content/items/${contentId}`, { method: 'PATCH', body: JSON.stringify({ status: 'review', caption: 'Обновлено из Android regression' }) });
  const library = await request('/content/media-library?limit=100&offset=0');
  assert(library.items.some((item) => item.id === mediaId), 'content media library does not contain marked media');
  ok('content plan create, update and media library');

  const users = await request('/users');
  let regressionUser = users.find((item) => item.login === 'android-regression');
  if (!regressionUser) {
    regressionUser = await request('/users', { method: 'POST', body: JSON.stringify({ display_name: 'Android Regression', login: 'android-regression', password: 'android-regression-2026', role: 'employee' }) }, [201]);
  }
  regressionUser = await request(`/users/${regressionUser.id}`, { method: 'PUT', body: JSON.stringify({ display_name: 'Android Regression', login: 'android-regression' }) });
  regressionUser = await request(`/users/${regressionUser.id}/permissions`, { method: 'PUT', body: JSON.stringify({ role: 'employee', can_create_shared_workspaces: false, can_create_private_workspaces: true, can_add_comments: true, can_upload_media: true, can_view_all_calendars: false, can_access_admin: false, can_access_chats: true, can_access_content: true, can_import_ios_photo_library: false }) });
  assert(regressionUser.can_access_content && regressionUser.can_upload_media, 'permissions were not saved');
  await request(`/users/${regressionUser.id}/password`, { method: 'PUT', body: JSON.stringify({ password: 'android-regression-2027' }) }, [204]);
  await request(`/users/${regressionUser.id}/active`, { method: 'PUT', body: JSON.stringify({ is_active: false }) });
  await request(`/users/${regressionUser.id}/active`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
  await request('/integrations');
  ok('admin users, permissions, password, activity and integrations');
} finally {
  if (contentId) await request(`/content/items/${contentId}`, { method: 'DELETE' }, [204]).catch((error) => console.warn(`cleanup content: ${error.message}`));
  if (discussionId) await request(`/discussions/${discussionId}`, { method: 'DELETE' }, [204]).catch((error) => console.warn(`cleanup discussion: ${error.message}`));
  if (mediaId) await request(`/media/${mediaId}`, { method: 'DELETE' }, [204]).catch((error) => console.warn(`cleanup media: ${error.message}`));
  if (token) {
    await request('/mobile/auth/logout', { method: 'POST' }, [204]);
    const revoked = await fetch(`${apiRoot}/mobile/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert(revoked.status === 401, 'logout did not revoke bearer token');
    ok('logout revokes mobile token');
  }
}

console.log(`\nAPI regression passed: ${passed.length} functional groups.`);
import { readFile } from 'node:fs/promises';

