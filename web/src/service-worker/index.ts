import { self } from "$app/service-worker";
import { immutable, assets } from "$app/manifest";
import { version } from "$app/env";

const CACHE = `dork-mail-${version}`;
// adapter-static's SPA fallback, served for every navigation so the app launches offline
const SHELL = "/index.html";
const PRECACHE = [SHELL, ...immutable.map(f => f.path), ...assets.map(f => f.path)];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The shell is cached per build, so launches are instant and a deploy is picked up
    // on the launch after the new worker installs.
    const cached = await cache.match(request.mode === "navigate" ? SHELL : request);
    return cached ?? fetch(request);
  })());
});

self.addEventListener("push", event => {
  let data: { title?: string; body?: string; tag?: string; url?: string; badge?: number } = {};
  try { data = event.data?.json() ?? {}; } catch { /* non-JSON payload */ }

  const work: Promise<unknown>[] = [
    self.registration.showNotification(data.title || "New mail", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/mail" },
    }),
    self.clients.matchAll({ type: "window" }).then(windows => {
      windows.forEach(c => c.postMessage({ type: "new-mail" }));
    }),
  ];
  if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
    work.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(work).catch(() => {}));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url: string = event.notification.data?.url || "/mail";

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find(c => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: "open", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
