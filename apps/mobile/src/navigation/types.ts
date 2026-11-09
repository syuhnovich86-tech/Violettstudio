export type RootTabs = {
  Archive: { workspaceId?: string; visitId?: number } | undefined;
  Visits: undefined;
  Add: { visitId?: number; visitName?: string; workspaceId?: string } | undefined;
  Content: { sourceMedia?: { id: string; mediaType: 'image' | 'video' } } | undefined;
  Chats: { sourceMedia?: { id: string; name: string } } | undefined;
};
