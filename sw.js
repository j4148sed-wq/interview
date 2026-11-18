// Service Worker: アプリ本体(HTML/CSS/JS)を端末にキャッシュする最小構成。
// ・常にネットワークを先に見に行き(=更新がすぐ反映される)、繋がらない時だけキャッシュを使う
// ・音声ファイル(Rangeリクエスト)と他サイト(Supabase など)への通信には関与しない
// 更新してもキャッシュが古いままの時は、下の CACHE の番号を上げる。
const CACHE = "self-interview-v10";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "config.js", "data/questions.js",
  "terms.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (req.headers.has("range") || /\.(mp3|m4a|wav|ogg|webm|aac)$/i.test(url.pathname)) return;

  e.respondWith(
    fetch(req, { cache: "no-cache" })   // ブラウザの一時保存を使わず、毎回サーバーに「更新があるか」を確認する
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
