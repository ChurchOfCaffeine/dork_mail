// Loaded into the generated service worker via workbox importScripts (vite.config.ts).

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const work = [
    self.registration.showNotification(data.title || "New mail", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/mail" },
    }),
  ];
  if (typeof data.badge === "number" && self.navigator.setAppBadge) {
    work.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  work.push(self.clients.matchAll({ type: "window" }).then((windows) => {
    windows.forEach((c) => c.postMessage({ type: "new-mail" }));
  }));
  event.waitUntil(Promise.all(work).catch(() => {}));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/mail";

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: "open", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
