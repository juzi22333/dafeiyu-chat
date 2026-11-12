/* 聊天室 PWA Service Worker
 * 只缓存「界面外壳」，/api/* 一律走网络（消息要实时，不能被缓存）。
 *
 * 策略（v19 起）：
 *  - 页面导航 / 静态资源 → stale-while-revalidate：先吐缓存让画面立刻出来，
 *    同时后台拉新版本更新缓存。这样从桌面点开几乎是秒开，不用等网络。
 *  - 更新靠 VERSION 递增 + 页面里 ?v= 版本号，改了代码就换缓存桶。
 */
'use strict';

const VERSION = 'dafeiyu-room-v30';
const SHELL = [
  '/room',
  '/room.html',
  '/login',
  '/login.html',
  '/register',
  '/register.html',
  '/bots',
  '/bots.html',
  '/auth-client.js',
  '/bots-client.js',
  '/view',
  '/view.html',
  '/view-client.js',
  '/style.css',
  '/room.css',
  '/room-client.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 先给缓存（有的话），同时后台更新 */
function staleWhileRevalidate(event, cacheKey) {
  const req = event.request;
  const cached = caches.match(cacheKey || req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(cacheKey || req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  event.respondWith(
    cached.then((hit) => {
      if (hit) return hit;
      return network.then((res) => res || caches.match('/room.html'));
    }),
  );
  event.waitUntil(network.catch(() => {}));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口永远走网络
  if (url.pathname.startsWith('/api/')) return;
  // 安装包不缓存，别占空间
  if (url.pathname.endsWith('.apk')) return;

  // 页面导航
  if (req.mode === 'navigate') {
    const path = url.pathname === '/' ? '/room.html' : url.pathname;
    staleWhileRevalidate(event, path);
    return;
  }

  // 静态资源
  staleWhileRevalidate(event, null);
});
