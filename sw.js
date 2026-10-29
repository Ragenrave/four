// Classic Four offline worker: keeps the app itself available offline.
// Budget data is stored separately in IndexedDB by the page.
const CACHE = 'four-app-v4';
const APP = ['./', 'index.html', 'ynab4-engine.js', 'statements.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // A statement shared from the banking app (Android share sheet → Four)
  if (e.request.method === 'POST' && url.search.includes('share-target')) {
    e.respondWith((async () => {
      try {
        const data = await e.request.formData();
        const f = data.get('statement');
        if (f && f.size) {
          const c = await caches.open('four-share');
          await c.put('shared-statement', new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'statement') } }));
        }
      } catch (err) {}
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
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
