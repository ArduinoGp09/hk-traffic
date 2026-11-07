const VERSION = 'hk-traffic-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const MAP_CACHE = `${VERSION}-map`;
const SHELL_FILES = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const CORE_REMOTE_FILES = [
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css',
  'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml',
  'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/basemap/WGS84/resources/styles/root.json',
  'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/label/hk/tc/WGS84/resources/styles/root.json',
  'https://tiles.openfreemap.org/planet'
];
const MAX_CACHED_TILES = 320;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await (await caches.open(SHELL_CACHE)).addAll(SHELL_FILES);
    // Best effort warm-up: these same public resources are required by the online map.
    await Promise.allSettled(CORE_REMOTE_FILES.map(async url => {
      const response = await fetch(url);
      if (response.ok && response.type !== 'opaque') await (await caches.open(RUNTIME_CACHE)).put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE, MAP_CACHE]);
    await Promise.all((await caches.keys()).filter(name => name.startsWith('hk-traffic-') && !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isTrafficSnapshot(url) {
  return url.hostname === 'tdcctv.data.one.gov.hk';
}

function isMapTile(url) {
  return url.pathname.endsWith('.pbf');
}

async function remember(cacheName, request, response) {
  if (!response || !response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') return;
  const cache = await caches.open(cacheName);
  try { await cache.put(request, response.clone()); } catch { return; }
  if (cacheName === MAP_CACHE) {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHED_TILES)).map(key => cache.delete(key)));
  }
}

async function fetchAndStore(cacheName, request) {
  const response = await fetch(request);
  await remember(cacheName, request, response);
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 交通鏡頭影像必須每次取最新相片，不放入離線快取。
  if (isTrafficSnapshot(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetchAndStore(SHELL_CACHE, request);
      } catch {
        const shell = await caches.open(SHELL_CACHE);
        return await shell.match('./index.html') || new Response('目前離線，請先連接網絡再開啟 hk-traffic。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (isMapTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try { return await fetchAndStore(MAP_CACHE, request); }
      catch { return new Response('', { status: 504, statusText: 'Offline map tile unavailable' }); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cacheName = url.origin === self.location.origin ? SHELL_CACHE : RUNTIME_CACHE;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const network = fetchAndStore(cacheName, request).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return await network || new Response('', { status: 504, statusText: 'Offline resource unavailable' });
  })());
});
