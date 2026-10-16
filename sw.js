// Offline copy of Trip Status. Everything is network first, so the newest trip list shows whenever the phone is online.
// When there is no connection, or it takes more than a few seconds, the last copy is used instead, and the trip list
// copy is marked so the page can say it is showing a saved list.
const CACHE = 'trip-status-v2';
const SHELL = ['./', 'trips.json', 'manifest.webmanifest', 'manifest-edit.webmanifest', 'icon-192.png', 'icon-180.png'];
const SLOW = 6000;

// Keep a first copy of the page and the list right away, so it opens offline even after a single visit.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(SHELL.map((u) => {
      const url = new URL(u, self.registration.scope).href;
      return fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? c.put(url, r) : null)).catch(() => null);
    })))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function savedCopy(c, key, why) {
  return c.match(key).then((hit) => {
    if (!hit || !/\.json$/.test(key)) return hit || null;
    const h = new Headers(hit.headers);
    h.set('X-Trip-Status-Cache', why);
    return hit.blob().then((b) => new Response(b, { status: hit.status, statusText: hit.statusText, headers: h }));
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(caches.open(CACHE).then((c) => new Promise((resolve, reject) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => savedCopy(c, key, 'slow').then(finish), SLOW);
    fetch(req, { cache: 'no-store' }).then((r) => {
      clearTimeout(timer);
      if (r.ok) c.put(key, r.clone()).catch(() => {});
      finish(r);
    }, (err) => {
      clearTimeout(timer);
      savedCopy(c, key, 'offline').then((hit) => { if (hit) finish(hit); else if (!done) { done = true; reject(err); } });
    });
  })));
});
