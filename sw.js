const CACHE_NAME = 'use-ellba-v1';
const ARQUIVOS_CACHE = [
  './',
  './index.html',
  './config.js',
  './api.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
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
  var url = event.request.url;
  // Nunca cacheia chamadas à API nem imagens do Drive: sempre precisam vir atualizadas.
  if (url.indexOf('script.google.com') > -1 || url.indexOf('drive.google.com') > -1 || url.indexOf('googleusercontent.com') > -1) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(function(resp) { return resp || fetch(event.request); })
  );
});
