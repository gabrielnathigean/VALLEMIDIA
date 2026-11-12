// Mantém a página do player disponível mesmo sem internet (túneis, sinal fraco)
const C = 'shell-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.add('/player.html'))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname === '/player.html') {
    e.respondWith(fetch(e.request).then(r => { caches.open(C).then(c => c.put('/player.html', r.clone())); return r; })
      .catch(() => caches.match('/player.html')));
  }
});
