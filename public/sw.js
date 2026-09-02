// PRONO SPORT — Service Worker (PWA v3.4)
// Coquille applicative en cache (app shell) ; API toujours réseau d'abord
// (données fraîches obligatoires — §11), avec message d'erreur honnête hors ligne.
const SHELL_CACHE = 'pronosport-shell-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    // API : réseau uniquement — jamais de données périmées présentées comme fraîches
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'OFFLINE', note: 'Hors ligne : données indisponibles (jamais de cache présenté comme frais).' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Shell : réseau d'abord, cache en secours (app utilisable hors ligne)
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
