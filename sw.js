// Offline support: the app shell is cached on install; fonts are same-origin and cached the first time they load.
// Bump VERSION whenever index.html changes so phones pick up the new copy.
const VERSION = 'dink-score-v203';
const SHELL = ['./', 'index.html', 'analytics.js', 'dupr-export.js', 'sheet-import.js', 'scan.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/pickleball.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Opt-in "you're up" notifications (api/_push.js). The payload is only a title, a line naming the player and court, and a tag.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Dink Score').slice(0, 80), {
    body: String(d.body || "You're up.").slice(0, 160), tag: d.tag ? String(d.tag).slice(0, 60) : undefined, renotify: !!d.tag,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: typeof d.url === 'string' && d.url.charAt(0) === '/' ? d.url : '/' }
  }));
});

// Tapping one opens the app: an open window is focused, otherwise a new one is opened.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.location.origin));
    return open && open.focus ? open.focus() : self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // club data always comes live from the server
  if (url.origin === location.origin && url.pathname.startsWith("/_vercel/")) return; // Vercel Web Analytics: never cached, and offline the script and beacon just fail quietly
  if (url.origin === location.origin && /^\/(b\/|r\/|privacy|terms)/.test(url.pathname)) return; // the public bracket page is its own page, never the app shell
  if (req.mode === 'navigate') {
    // Network first for the page, so updates arrive; fall back to the cached copy offline.
    // Only a good page is kept: an error page must never become the offline copy.
    e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); } return res; })
      .catch(() => caches.match('index.html').then(hit => hit || caches.match('./'))));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
