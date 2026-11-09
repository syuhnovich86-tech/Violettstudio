import assert from 'node:assert/strict';
import { filterAndroidDiscussions } from '../src/chats/discussionFilters.ts';

const items = [
  { id: 'chat', kind: 'custom', is_private: true, title: 'Личный чат', client_name: null, last_message: '' },
  { id: 'public', kind: 'batch', is_private: false, title: 'Серия', client_name: 'Виолетта', last_message: 'Готово', mentioned_me: true },
  { id: 'private', kind: 'batch', is_private: true, title: 'Другой материал', client_name: null, last_message: 'Тест', mentioned_me: false },
  { id: 'no-mention', kind: 'batch', is_private: false, title: 'Ещё серия', client_name: null, last_message: '', mentioned_me: false },
];
const ids = (tab, search = '', mentions = false) => filterAndroidDiscussions(items, tab, search, mentions).map((item) => item.id);
assert.deepEqual(ids('all'), ['chat']);
assert.deepEqual(ids('comments'), ['public', 'no-mention']);
assert.deepEqual(ids('comments', '', true), ['public']);
assert.deepEqual(ids('comments', 'виолетта'), ['public']);
assert.deepEqual(ids('private'), ['private']);
console.log('Android discussion tabs, mentions and search match web');
