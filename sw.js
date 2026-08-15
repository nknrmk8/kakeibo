/* ふたり家計簿 — オフライン用サービスワーカー
   アプリ本体はネットワーク優先（更新をすぐ反映）＋ 圏外ではキャッシュから表示。
   文字認識の一式（vendor/）はキャッシュ優先で、一度読めばオフラインでも使える。

   ※ index.html の app.css / app.js の v= を変えたら、ここの VERSION も同じ値にすること。 */
const VERSION = '20260815b';
const CACHE = 'futari-kakeibo-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './app.css?v=' + VERSION,
  './app.js?v=' + VERSION
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 文字認識の一式は容量が大きく中身も変わらないので、キャッシュ優先
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // アプリ本体はネットワーク優先。no-cache を付けて毎回サーバーに確認させ、
  // 古いファイルがブラウザに残り続けないようにする。
  let fresh = req;
  try { fresh = new Request(req, { cache: 'no-cache' }); } catch (err) { /* そのまま使う */ }

  e.respondWith(
    fetch(fresh)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
