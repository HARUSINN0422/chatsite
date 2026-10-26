const CACHE_PREFIX = "chatsite-shell-";
const CACHE_NAME = CACHE_PREFIX + "v3";
const SHELL = ["/", "/index.html", "/manifest.json"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname.endsWith("/") || /\\.(html|js|json|css)$/.test(url.pathname))) {
      const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("/index.html"))));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "新しいメッセージが届きました" }; }
  event.waitUntil(self.registration.showNotification(data.title || "ChatSite", {
    body: data.body || "新しいメッセージが届きました",
    data: { url: data.url || "/" }, tag: "chatsite-message", renotify: true
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    for (const client of clients) if (client.url.startsWith(self.location.origin) && "focus" in client) return client.focus();
    if (self.clients.openWindow) return self.clients.openWindow(target);
  }));
});
