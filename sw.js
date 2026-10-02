// Minimal service worker: makes the app installable without caching anything, so a
// deploy is never hidden behind a stale cache. Data offline is handled by app.js.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_PAGE = `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consultorio</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#F5F7FA;color:#1E2F45;text-align:center;padding:24px">
<div><h1 style="font-size:22px">Sin conexión</h1><p>Abrí la app de nuevo cuando vuelva internet.</p></div>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  );
});
