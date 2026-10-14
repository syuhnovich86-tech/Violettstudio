self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "Новое сообщение" };
  }
  event.waitUntil(self.registration.showNotification(payload.title || "VIOLETTA — новое сообщение", {
    body: payload.body || "В ваших чатах появилось новое сообщение",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "vita29-chat-message",
    renotify: true,
    data: { url: payload.url || "/#chats" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(event.notification.data?.url || "/#chats");
      return existing.focus();
    }
    return self.clients.openWindow(event.notification.data?.url || "/#chats");
  })());
});
