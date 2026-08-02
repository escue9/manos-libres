/* sw.js — Service Worker
 *
 * La cocina del CIC tiene conexión inestable: la app tiene que abrir siempre.
 * Estrategia: cache-first para el shell, con actualización en segundo plano.
 *
 * Los DATOS no pasan por acá — viven en IndexedDB vía js/db.js.
 *
 * Subí CACHE_VERSION en cada deploy o los usuarios quedan con la versión vieja.
 */

const CACHE_VERSION = 'cocina-cic-v6';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/components.css',
  './js/app.js',
  './js/db.js',
  './js/login.js',
  './js/state.js',
  './js/calc.js',
  './js/auth.js',
  './js/ui.js',
  './js/nube.js',
  './js/qr.js',
  './js/modules/produccion.js',
  './js/modules/pedidos.js',
  './js/modules/canal-web.js',
  './js/modules/trabajadoras.js',
  './js/modules/caja.js',
  './assets/logo.png',
  './assets/logo-192.png',
  './assets/logo-maskable.png',
  './assets/logo-mark.png',
  './assets/favicon.png',
  './assets/shortcut-venta.png',
  './assets/shortcut-pedido.png',
  './assets/shortcut-jornada.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll falla entero si un recurso falla; toleramos faltantes en desarrollo
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Las fuentes de Google se cachean al vuelo: si no hay red, se usa la del sistema
  const esFuente = url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');

  // Navegación: red primero, cache como red de contención.
  //
  // El r.ok/r.type NO es opcional: sin eso se cacheaba CUALQUIER respuesta
  // como index.html. En una red con portal cautivo —las del CIC y las de los
  // clubes lo son— el fetch resuelve 200 con el HTML del portal, queda
  // guardado, y a partir de ahí abrir la app sin internet muestra la pantalla
  // del portal para siempre. Lo mismo con un 502 durante un deploy.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((r) => {
          if (r.ok && r.type === 'basic') {
            const copia = r.clone();
            caches.open(CACHE_VERSION).then((c) => c.put('./index.html', copia));
          }
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto: cache primero, revalidando en segundo plano
  e.respondWith(
    caches.match(request).then((cached) => {
      const red = fetch(request)
        .then((r) => {
          if (r.ok && (url.origin === location.origin || esFuente)) {
            const copia = r.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(request, copia));
          }
          return r;
        })
        // Sin red y sin copia hay que devolver una Response igual: si acá se
        // resuelve undefined, respondWith tira y la pantalla queda en blanco
        // sin explicación, que es justo lo que la regla 3 no permite
        .catch(() => cached || new Response('Sin conexión y sin copia local', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }));
      return cached || red;
    })
  );
});
