const CACHE_NAME = "daymark-shell-v4";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

// Install – precache shell, then take over immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => {
        // Don't block install if a shell file is temporarily missing
        console.warn("[sw] precache failed", err);
        return self.skipWaiting();
      })
  );
});

// Activate – delete every old cache, then claim clients
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Allow the page to activate a waiting worker immediately (Chrome Android)
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: always try network first, fall back to cached shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put("/", copy);
              cache.put("/index.html", response.clone());
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = (await caches.match("/")) || (await caches.match("/index.html"));
          return (
            cached ||
            new Response("<h1>Daymark is offline</h1><p>Reconnect and reload.</p>", {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        })
    );
    return;
  }

  // Build assets (/assets/*) and JS/CSS: network-first so new deploys always win
  // Stale hashed files are never kept longer than the current CACHE_NAME
  const isBuildAsset =
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css");

  if (isBuildAsset) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Icons / static images: cache-first is fine
  if (
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".woff2") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Default: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// Push notifications
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "" };
  }

  const title = payload.title || "Daymark reminder";
  const options = {
    body: payload.body || "You have an upcoming activity.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || payload.reminderId || "daymark-reminder",
    data: {
      url: payload.url || "/",
      reminderId: payload.reminderId || null,
    },
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click → open / focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(
    event.notification.data?.url || "/",
    self.location.origin
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) =>
          client.url.startsWith(self.location.origin)
        );
        if (existing) {
          existing.navigate(destination);
          return existing.focus();
        }
        return self.clients.openWindow(destination);
      })
  );
});
