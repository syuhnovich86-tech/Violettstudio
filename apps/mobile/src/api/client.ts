import * as SecureStore from 'expo-secure-store';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

export const API_ROOT = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'https://vita29.taild51e5c.ts.net/api/v1' : 'https://31-10-64-46.sslip.io/api/v1')).replace(/\/$/, '');
const ACCESS_TOKEN_KEY = 'violetta.mobile-access-token';
let cachedAccessToken: string | null = null;

export type Role = 'owner' | 'admin' | 'employee';
export type ApiUser = {
  id: string; display_name: string; login: string; role: Role; is_active: boolean;
  can_create_shared_workspaces: boolean; can_create_private_workspaces: boolean;
  can_delete_workspaces?: boolean;
  can_add_comments: boolean; can_upload_media: boolean; can_view_all_calendars: boolean;
  can_access_admin: boolean; can_access_chats: boolean; can_access_content: boolean;
  can_access_analytics?: boolean;
  can_import_ios_photo_library: boolean;
  can_import_android_photo_library?: boolean;
};
export type Workspace = { id: string; display_name: string; kind: 'studio' | 'private'; owner_id: string; role: Role; file_count: number; size_bytes: number };
export type MediaFile = {
  id: string; owner_id: string; owner_name: string; workspace_id: string; workspace_name: string;
  workspace_kind: 'studio' | 'private'; original_name: string; media_type: 'image' | 'video';
  mime_type: string; size_bytes: number; created_at: string; captured_at: string | null;
  location_country: string | null; location_city: string | null; location_key: string | null;
  can_delete: boolean; publication_allowed: boolean; content_marked: boolean; comment: string | null;
  batch_id: string | null; batch_comment: string | null;
};
export type MediaBatch = { id: string; workspace_id: string; yclients_record_id: number | null; comment: string | null; created_at: string };
export type CalendarUser = { user_id: string; display_name: string };
export type Visit = { record_id: number; user_id: string | null; starts_at: string; client_name: string | null; services: string[]; comment: string | null; media_count: number; staff_name: string | null };
export type Discussion = { id: string; title: string; kind: 'general' | 'custom' | 'batch'; batch_id: string | null; client_name: string | null; member_ids: string[]; unread_count: number; first_unread_message_id: string | null; last_message: string | null; updated_at: string; can_delete: boolean; mentioned_me: boolean; is_private: boolean };
export type Participant = { id: string; display_name: string };
export type DiscussionAttachment = { media_id: string; media_type: 'image' | 'video'; original_name: string; batch_id: string | null; thumbnail_url: string; preview_url: string };
export type DiscussionMessage = { id: string; discussion_id: string; author_id: string | null; author_name: string; body: string | null; reply_to: { id: string; author_name: string; body: string | null } | null; batch_id: string | null; attachments: DiscussionAttachment[]; reactions: Record<string, number>; my_reactions: string[]; like_count: number; liked_by_me: boolean; created_at: string };
export type NotificationSummary = { unread_count: number; notifications: Array<{ id: string; kind: string; discussion_id: string | null; message_id: string | null; actor_name: string | null; read: boolean; created_at: string }> };
export type ContentPublication = { id: string; platform: 'telegram' | 'max' | 'instagram' | 'vk' | 'threads'; publication_format?: 'post' | 'story' | 'reel'; status: string; caption: string | null; media_ids: string[]; external_id: string | null; error: string | null; published_at: string | null };
export type ContentArchiveEntry = { publication_id: string; item_id: string; title: string; description: string | null; platform: ContentPublication['platform']; platforms?: ContentPublication['platform'][]; publication_format: string; published_at: string; media_ids: string[]; preview_media_id: string | null };
export type ContentArchivePage = { items: ContentArchiveEntry[]; next_offset: number | null };
export type ContentItem = { id: string; title: string; caption: string | null; editor_instruction: string | null; visual_edit_requested?: boolean; content_format: 'post' | 'story' | 'availability'; media_limit: number; availability_staff_id: number | null; availability_slots: Array<Record<string, unknown>>; status: string; scheduled_at: string; publication_date_assigned?: boolean; media_ids: string[]; created_by_id: string; approved_by_id: string | null; approved_at: string | null; publications: ContentPublication[]; created_at: string; updated_at: string };
export type ContentLibrary = { items: Array<{ id: string; original_name: string; media_type: 'image' | 'video'; thumbnail_url: string; comment: string | null; content_marked: boolean; workspace_id: string; workspace_name: string }>; workspaces: Array<{ id: string; display_name: string; kind: 'studio' | 'private' }>; total: number; next_offset: number | null };
export type StorageStatus = { total_bytes: number; used_bytes: number; free_bytes: number; media_bytes: number; used_percent: number };
export type IntegrationStatus = Record<'openai' | 'telegram' | 'max' | 'instagram' | 'vk' | 'threads' | 'threads', { configured: boolean; fields: Record<string, string> }>;
export type SessionResponse = { user: ApiUser; csrf_token: string };
type MobileSessionResponse = { user: ApiUser; access_token: string; expires_at: string };

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function accessToken() {
  if (cachedAccessToken !== null) return cachedAccessToken || null;
  cachedAccessToken = (await SecureStore.getItemAsync(ACCESS_TOKEN_KEY)) ?? '';
  return cachedAccessToken || null;
}
async function saveAccessToken(token: string) {
  cachedAccessToken = token;
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
async function clearAccessToken() { cachedAccessToken = ''; await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY); }

// Background transfers can use the token after the first unlock following a reboot.
export async function allowBackgroundAccessToSession() {
  const token = await accessToken();
  if (!token) throw new Error('Войдите в приложение перед включением синхронизации.');
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/api/v1/') ? path.slice('/api/v1'.length) : path;
  return `${API_ROOT}${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
}
export async function authorizedSource(path: string) {
  const token = await accessToken();
  return { uri: apiUrl(path), headers: token ? { Authorization: `Bearer ${token}` } : undefined };
}
function errorText(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((item) => (item as { msg?: string }).msg ?? 'Ошибка данных').join('\n');
  }
  return `Ошибка сервера ${status}`;
}
export async function apiRequest<T>(path: string, options: RequestInit = {}, mutation = false, timeoutMs = options.body instanceof FormData ? 180_000 : 25_000): Promise<T> {
  const headers = new Headers(options.headers);
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternalSignal = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  let response: Response;
  try { response = await fetch(apiUrl(path), { ...options, headers, credentials: 'include', signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new ApiError('Сервер не ответил вовремя. Повторите попытку.', 0);
    if (error instanceof TypeError) throw new ApiError('Нет связи с сервером. Проверьте интернет.', 0);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromExternalSignal);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) cachedAccessToken = '';
    throw new ApiError(errorText(body, response.status), response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
function query(path: string, values: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params.set(key, String(value)); });
  return params.size ? `${path}?${params.toString()}` : path;
}

export async function login(loginName: string, password: string) {
  cachedAccessToken = '';
  const session = await apiRequest<MobileSessionResponse>('/mobile/auth/login', { method: 'POST', body: JSON.stringify({ login: loginName, password }) });
  await saveAccessToken(session.access_token);
  return { user: session.user, csrf_token: '' } satisfies SessionResponse;
}
export async function restoreSession() { const user = await apiRequest<ApiUser>('/mobile/auth/me'); return { user, csrf_token: '' } satisfies SessionResponse; }
export async function logout() { try { await apiRequest<void>('/mobile/auth/logout', { method: 'POST' }, true); } finally { await clearAccessToken(); } }

export const listWorkspaces = () => apiRequest<Workspace[]>('/workspaces');
export const createWorkspace = (display_name: string, kind: Workspace['kind']) => apiRequest<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ display_name, kind }) }, true);
export const makeAndroidBackupPrivate = (id: string) => apiRequest<Workspace>(`/workspaces/${id}/android-backup-private`, { method: 'POST' }, true);
export const deleteWorkspace = (id: string) => apiRequest<void>(`/workspaces/${id}`, { method: 'DELETE' }, true);
export const listMedia = (filters: Record<string, string | number | boolean | null | undefined> = {}) => apiRequest<MediaFile[]>(query('/media', filters));
export type MediaFilterOptions = { years: number[]; months: Array<{ year: number; month: number; count: number }>; places: Array<{ key: string; country: string | null; city: string | null; label: string }>; without_location_count: number };
export const getMediaFilterOptions = (workspace_id: string, capture_year?: number, capture_month?: number) => apiRequest<MediaFilterOptions>(query('/media/filter-options', { workspace_id, capture_year, capture_month }));
export const createMediaBatch = (workspace_id: string, yclients_record_id: number | null, comment: string | null) => apiRequest<MediaBatch>('/media/batches', { method: 'POST', body: JSON.stringify({ workspace_id, yclients_record_id, comment }) }, true);
export const moveMedia = (id: string, workspace_id: string) => apiRequest<MediaFile>(`/media/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspace_id }) }, true);
export const setMediaPublication = (id: string, publication_allowed: boolean) => apiRequest<MediaFile>(`/media/${id}/publication`, { method: 'PUT', body: JSON.stringify({ publication_allowed }) }, true);
export const setMediaContentMark = (id: string, content_marked: boolean) => apiRequest<MediaFile>(`/media/${id}/content-mark`, { method: 'PUT', body: JSON.stringify({ content_marked }) }, true);
export const setMediaComment = (id: string, comment: string | null) => apiRequest<MediaFile>(`/media/${id}/comment`, { method: 'PUT', body: JSON.stringify({ comment }) }, true);
export const deleteMedia = (id: string) => apiRequest<void>(`/media/${id}`, { method: 'DELETE' }, true);
export async function uploadMedia(input: { uri: string; filename: string; mediaType: 'image' | 'video'; mimeType?: string | null; workspaceId: string; visitId?: number | null; batchId?: string | null; publicationAllowed?: boolean }) {
  const form = new FormData();
  const file = new File(input.uri);
  form.append('upload', file, input.filename);
  return apiRequest<MediaFile>(query('/media', { workspace_id: input.workspaceId, yclients_record_id: input.visitId, batch_id: input.batchId, publication_allowed: input.publicationAllowed ?? false }), { method: 'POST', body: form }, true, input.mediaType === 'video' ? 900_000 : 180_000);
}

export const iphoneImportStatus = (workspaceId: string, importKey: string) => apiRequest<{ exists: boolean }>(query('/media/ios-import/status', { workspace_id: workspaceId }), { headers: { 'X-Ios-Import-Key': importKey } });
export const iphoneImportProgress = (workspaceId: string, importKey: string, total: number) => apiRequest<{ exists: boolean; offset: number }>(query('/media/ios-import/progress', { workspace_id: workspaceId, total }), { headers: { 'X-Ios-Import-Key': importKey } });
export const finishIphoneImport = (workspaceId: string, importKey: string, total: number) => apiRequest<{ exists: boolean; media_id: string }>(query('/media/ios-import/complete', { workspace_id: workspaceId, total }), { method: 'POST', headers: { 'X-Ios-Import-Key': importKey } }, true, 600_000);
export const androidImportStatus = (workspaceId: string, importKey: string) => apiRequest<{ exists: boolean }>(query('/media/android-import/status', { workspace_id: workspaceId }), { headers: { 'X-Android-Import-Key': importKey } });
export const androidImportProgress = (workspaceId: string, importKey: string, total: number) => apiRequest<{ exists: boolean; offset: number }>(query('/media/android-import/progress', { workspace_id: workspaceId, total }), { headers: { 'X-Android-Import-Key': importKey } });
export const finishAndroidImport = (workspaceId: string, importKey: string, total: number) => apiRequest<{ exists: boolean; media_id: string }>(query('/media/android-import/complete', { workspace_id: workspaceId, total }), { method: 'POST', headers: { 'X-Android-Import-Key': importKey } }, true, 600_000);

export const listCalendarUsers = () => apiRequest<CalendarUser[]>('/yclients/calendar-users');
export const listVisits = (start_date: string, end_date: string, user_id?: string) => apiRequest<Visit[]>(query('/yclients/visits', { start_date, end_date, user_id }));
export const syncVisits = (start_date: string, end_date: string) => apiRequest<{ processed: number; linked: number; unlinked: number }>('/yclients/sync', { method: 'POST', body: JSON.stringify({ start_date, end_date }) }, true, 120_000);

export const listDiscussions = (search?: string) => apiRequest<Discussion[]>(query('/discussions', { search: search?.trim() || undefined }));
export const listParticipants = () => apiRequest<Participant[]>('/discussions/participants');
export const createDiscussion = (title: string, member_ids: string[]) => apiRequest<Discussion>('/discussions', { method: 'POST', body: JSON.stringify({ title, member_ids }) }, true);
export const deleteDiscussion = (id: string) => apiRequest<void>(`/discussions/${id}`, { method: 'DELETE' }, true);
export const listMessages = (id: string, filters: Record<string, string | number | undefined> = {}) => apiRequest<DiscussionMessage[]>(query(`/discussions/${id}/messages`, filters));
export const sendMessage = (id: string, body: string | null, attachments: string[], reply_to_id?: string | null, batch_id?: string | null) => apiRequest<DiscussionMessage>(`/discussions/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, reply_to_id, batch_id, attachments: attachments.map((media_id) => ({ media_id })) }) }, true);
export const reactToMessage = (discussionId: string, messageId: string, emoji: string) => apiRequest<DiscussionMessage>(`/discussions/${discussionId}/messages/${messageId}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji }) }, true);
export const likeMessage = (discussionId: string, messageId: string) => apiRequest<DiscussionMessage>(`/discussions/${discussionId}/messages/${messageId}/like`, { method: 'PUT' }, true);
export const markDiscussionRead = (discussionId: string, message_id: string | null) => apiRequest<void>(`/discussions/${discussionId}/read`, { method: 'PUT', body: JSON.stringify({ message_id }) }, true);
export const listChatMedia = () => apiRequest<DiscussionAttachment[]>('/discussions/media-library');
export const getNotifications = () => apiRequest<NotificationSummary>('/discussions/notifications/inbox');
export const markAllNotificationsRead = () => apiRequest<void>('/discussions/notifications/read-all', { method: 'PUT' }, true);

export const listAvailabilityStaff = () => apiRequest<Array<{ staff_id: number; staff_name: string; specialization: string | null }>>('/content/availability/staff');
export const listContent = (week_start: string) => apiRequest<ContentItem[]>(query('/content/items', { week_start }));
export const listContentArchive = (offset = 0) => apiRequest<ContentArchivePage>(query('/content/archive', { offset, limit: 30 }));
export const reuseContentArchive = (id: string, platforms: string[]) => apiRequest<ContentItem>(`/content/archive/${id}/reuse`, { method: 'POST', body: JSON.stringify({ platforms }) }, true);
export const createContent = (payload: Record<string, unknown>) => apiRequest<ContentItem>('/content/items', { method: 'POST', body: JSON.stringify(payload) }, true);
export const createContentBulk = (items: Record<string, unknown>[]) => apiRequest<ContentItem[]>('/content/items/bulk', { method: 'POST', body: JSON.stringify({ items }) }, true);
export const startContentPlan = (item_ids: string[]) => apiRequest<{ results: Array<{ id: string; scheduled: boolean; error?: string }> }>('/content/plan/start', { method: 'POST', body: JSON.stringify({ item_ids }) }, true, 3_600_000);
export const updateContent = (id: string, payload: Record<string, unknown>) => apiRequest<ContentItem>(`/content/items/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }, true);
export const rollbackContent = (id: string) => apiRequest<ContentItem>(`/content/items/${id}/rollback`, { method: 'POST' }, true);
export const prepareContent = (id: string) => apiRequest<ContentItem>(`/content/items/${id}/prepare`, { method: 'POST' }, true, 600_000);
export const scheduleContent = (id: string) => apiRequest<ContentItem>(`/content/items/${id}/schedule`, { method: 'POST' }, true);
export const publishContentNow = (id: string, platform: ContentPublication['platform']) => apiRequest<ContentItem>(`/content/items/${id}/publications/${platform}/publish-now`, { method: 'POST' }, true, 600_000);
export const publishSelectedContent = (id: string) => apiRequest<{ item: ContentItem; results: Array<{ platform: ContentPublication['platform']; published: boolean; error?: string }> }>(`/content/items/${id}/publish-selected`, { method: 'POST' }, true, 600_000);
export const removeContentPlatform = (id: string, platform: ContentPublication['platform'], publicationId?: string) => apiRequest<ContentItem>(`/content/items/${id}/publications/${platform}${publicationId ? `?publication_id=${encodeURIComponent(publicationId)}` : ''}`, { method: 'DELETE' }, true);
export const confirmContentNotPublished = (id: string, platform: ContentPublication['platform'], publicationId?: string) => apiRequest<ContentItem>(`/content/items/${id}/publications/${platform}/confirm-not-published${publicationId ? `?publication_id=${encodeURIComponent(publicationId)}` : ''}`, { method: 'POST' }, true);
export const generateContentVisual = (id: string, instruction: string, source_media_ids: string[]) => apiRequest<ContentItem>(`/content/items/${id}/visual`, { method: 'POST', body: JSON.stringify({ instruction, source_media_ids }) }, true, 240_000);
export const updatePublicationMedia = (id: string, platform: string, publicationId: string, mediaIds: string[]) => apiRequest<ContentItem>(`/content/items/${id}/publications/${platform}/media?publication_id=${encodeURIComponent(publicationId)}`, { method: 'PATCH', body: JSON.stringify({ media_ids: mediaIds }) }, true);
export const updatePublicationCaption = (id: string, platform: string, caption: string | null, publicationId?: string) => apiRequest<ContentItem>(`/content/items/${id}/publications/${platform}/caption${publicationId ? `?publication_id=${encodeURIComponent(publicationId)}` : ''}`, { method: 'PATCH', body: JSON.stringify({ caption }) }, true);
export const publishTelegram = (id: string) => apiRequest<ContentItem>(`/content/items/${id}/publications/telegram`, { method: 'POST' }, true, 120_000);
export const deleteContent = (id: string) => apiRequest<void>(`/content/items/${id}`, { method: 'DELETE' }, true);
export const getContentLibrary = (workspace_id?: string, search?: string, offset = 0) => apiRequest<ContentLibrary>(query('/content/media-library', { workspace_id, search, offset, limit: 100, sort: Platform.OS === 'android' && workspace_id ? 'recent' : undefined }));

export const getStorage = () => apiRequest<StorageStatus>('/storage');
export const changePassword = (current_password: string, new_password: string) => apiRequest<void>('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password, new_password }) }, true);
export const listUsers = () => apiRequest<ApiUser[]>('/users');
export const createUser = (payload: { display_name: string; login: string; password: string; role: Role }) => apiRequest<ApiUser>('/users', { method: 'POST', body: JSON.stringify(payload) }, true);
export const updateUser = (id: string, display_name: string, loginName: string) => apiRequest<ApiUser>(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ display_name, login: loginName }) }, true);
export const resetUserPassword = (id: string, password: string) => apiRequest<void>(`/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }, true);
export const setUserActive = (id: string, is_active: boolean) => apiRequest<ApiUser>(`/users/${id}/active`, { method: 'PUT', body: JSON.stringify({ is_active }) }, true);
export const updatePermissions = (id: string, payload: Pick<ApiUser, 'role' | 'can_create_shared_workspaces' | 'can_create_private_workspaces' | 'can_delete_workspaces' | 'can_add_comments' | 'can_upload_media' | 'can_view_all_calendars' | 'can_access_admin' | 'can_access_chats' | 'can_access_content' | 'can_access_analytics' | 'can_import_ios_photo_library' | 'can_import_android_photo_library'>) => apiRequest<ApiUser>(`/users/${id}/permissions`, { method: 'PUT', body: JSON.stringify(payload) }, true);
export const getIntegrations = () => apiRequest<IntegrationStatus>('/integrations');
export const updateIntegrations = (payload: Record<string, string | null>) => apiRequest<IntegrationStatus>('/integrations', { method: 'PUT', body: JSON.stringify(payload) }, true);
