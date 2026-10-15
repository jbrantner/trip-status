// Offline copy of Trip Status. Everything is network-first, so the newest trip list shows whenever the phone
// is online; the last copy is used only when there is no connection.
const CACHE = 'trip-status-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try { const r = await fetch(req, { cache: 'no-store' }); if (r.ok) c.put(req.url.split('?')[0], r.clone()); return r; }
    catch (err) { const hit = await c.match(req.url.split('?')[0]); if (hit) return hit; throw err; }
  })());
});
