importScripts('./config.js', './sync-core.js');
const CACHE_NAME = 'use-ellba-v17';
const ARQUIVOS_CACHE = [
  './',
  './index.html',
  './config.js',
  './api.js',
  './sync-core.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ARQUIVOS_CACHE); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(nomes) {
      return Promise.all(nomes.filter(function(n) { return n !== CACHE_NAME; }).map(function(n) { return caches.delete(n); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  var req = event.request, url = req.url;
  if (req.method !== 'GET') return;
  // Nunca guarda chamadas à API, fotos do Drive nem do Cloudinary: precisam vir atualizadas.
  if (url.indexOf('script.google.com') > -1 || url.indexOf('drive.google.com') > -1 || url.indexOf('googleusercontent.com') > -1 || url.indexOf('cloudinary.com') > -1) {
    return;
  }
  // "Mostra o que já tem e atualiza por trás": o app abre na hora mesmo com sinal fraco ou sem internet.
  // A versão nova baixada por trás passa a valer na próxima vez que o app abrir.
  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(req, { ignoreSearch: true }).then(function(guardado) {
        var rede = fetch(req).then(function(respRede) {
          if (respRede && (respRede.ok || respRede.type === 'opaque')) cache.put(req, respRede.clone());
          return respRede;
        }).catch(function() { return guardado; });
        return guardado || rede;
      });
    })
  );
});

// Android: envia a fila de vendas pendentes em segundo plano quando a internet volta
self.addEventListener('sync', function(event) {
  if (event.tag === 'ellba-sync') {
    event.waitUntil(ellbaSincronizar().then(function(r) {
      return self.clients.matchAll({ type: 'window' }).then(function(cs) { cs.forEach(function(c) { c.postMessage('ellba-sync'); }); });
    }));
  }
});
