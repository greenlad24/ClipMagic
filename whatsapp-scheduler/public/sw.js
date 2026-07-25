'use strict';

// Service worker — caches the app shell so the status page is installable and
// loads offline. API responses are always fetched from the network (never
// cached) so status and the message list stay live.

const CACHE = 'wa-scheduler-shell-v1';

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon16.png',
  '/icons/icon48.png',
  '/icons/icon128.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never serve API calls from cache — they must be live.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // Cache-first for the app shell; fall back to network, then to index.html
  // for navigations when offline.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      });
    }),
  );
});
