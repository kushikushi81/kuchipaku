// KuchiPaku Service Worker — PWAオフライン対応
const CACHE = 'kuchipaku-v4';

// キャッシュ優先（変化しないアセット）
const STATIC_ASSETS = [
  './character.png',
  './manifest.json',
];

// ネットワーク優先（頻繁に変わるアプリコード）
const LIVE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './rec-worker.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([...STATIC_ASSETS, ...LIVE_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { pathname } = new URL(e.request.url);

  // OBS同期API(/sync/)はSWの管轄外にする。
  // SSEの無限ストリームをcache.putすると完了せずメモリを食い続け、POSTはcache.putが例外になるため
  if (pathname.startsWith('/sync/')) return;

  const isStatic = STATIC_ASSETS.some(p => pathname.endsWith(p.replace('./', '/')));

  if (isStatic) {
    // キャッシュ優先：なければネットワークから取得
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  } else {
    // ネットワーク優先：失敗時はキャッシュにフォールバック
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
