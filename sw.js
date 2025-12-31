'use strict';

const CACHE_NAME = 'bm-cache-v12.31.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',

  './supabase-config.js',
  './cloud-supabase.js',

  './ward-core.js',
  './ward-features.js',
  './ward-dnd.js',
  './ward-kpi.js',
  './ward-ui-wardlist.js',
  './ward-ui-sheet.js',
  './ward-sheet-table.js',
  './ward-sheet.js',
  './ward_occupancy_idealizer.js',

  './dpc_master.js',
  './app.js',

  './manifest.webmanifest',
  './icons/192.png',
  './icons/512.png'
];

// install: 事前キャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// activate: 古いキャッシュ掃除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// fetch: 基本は cache-first、HTMLだけ network-first（更新が反映されやすい）
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // supabaseやCDNはキャッシュに寄せない
  if (url.hostname.includes('supabase.co') || url.hostname.includes('jsdelivr.net')) {
    return;
  }

  // HTMLは network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // それ以外は cache-first
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
