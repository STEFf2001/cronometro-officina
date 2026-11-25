/* Service worker: tiene in memoria i file dell'app per aprirla anche senza rete.
 * A ogni nuova versione dell'app cambiare il numero qui sotto, così il telefono scarica i file nuovi. */
const CACHE = 'cronometro-officina-v1.0.0';
const FILE = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icone/icona-180.png',
  './icone/icona-192.png',
  './icone/icona-512.png',
  './icone/icona-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(chiavi => Promise.all(chiavi.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Solo i file dell'app; le chiamate allo script Google passano dirette in rete
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(inCache => {
      const daRete = fetch(req).then(r => {
        if (r && r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(req, copia));
        }
        return r;
      }).catch(() => inCache);
      // Prima la copia salvata (veloce, funziona offline), intanto si aggiorna in background
      return inCache || daRete;
    })
  );
});
