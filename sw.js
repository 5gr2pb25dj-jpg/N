/* ============================================================
   Service Worker
   ホーム画面から開いたときに古い画面が出続けるのを防ぐ。

   画面（HTML）は毎回ネットワークを先に見に行き、新しいものがあれば
   それを表示する。圏外や電波が弱い工場内では、直前に取得したものを
   キャッシュから出して動かし続ける。
   ============================================================ */
const VERSION = "2026.08.31-11";
const CACHE = `factory-${VERSION}`;

// 圏外でも起動できるように最初から持っておくもの
const SHELL = [
  "./",
  "./index.html",
  "./bg.jpg?v=2",
  "./boot-sky.jpg?v=3",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.png",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 1つ取れなくても導入は止めない
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith("factory-") && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ネットワーク優先。遅いときは待たせすぎないよう6秒で打ち切る
async function networkFirst(req, timeoutMs) {
  const cache = await caches.open(CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(req, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req) || await cache.match("./index.html");
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 画面そのものは必ず新しいものを見に行く
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, 6000));
    return;
  }

  // 画像などはキャッシュを先に返しつつ、裏で新しくしておく
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const fresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await fresh) || Response.error();
  })());
});
