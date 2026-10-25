// Classic Four offline worker: keeps the app itself available offline.
// Budget data is stored separately in IndexedDB by the page.
const CACHE = 'four-app-v1';
const APP = ['./', 'index.html', 'ynab4-engine.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Google sign-in and Drive always go to the network
  if (/googleapis\.com$|google\.com$|gstatic\.com$/.test(url.hostname) && !/fonts\./.test(url.hostname)) return;
  // app files and fonts: answer from cache, refresh in the background
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
