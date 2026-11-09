import type { Discussion } from '../api/client';

export function filterAndroidDiscussions(items: Discussion[], tab: 'all' | 'comments' | 'private', search: string, mentionsOnly: boolean): Discussion[] {
  const query = search.trim().toLocaleLowerCase('ru-RU');
  return items.filter((item) => {
    if (tab === 'all' && item.kind === 'batch') return false;
    if (tab !== 'all' && (item.kind !== 'batch' || item.is_private !== (tab === 'private'))) return false;
    if (tab === 'comments' && mentionsOnly && !item.mentioned_me) return false;
    return !query || [item.title, item.client_name, item.last_message].some((value) => value?.toLocaleLowerCase('ru-RU').includes(query));
  });
}
