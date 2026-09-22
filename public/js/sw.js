// sw.js — Service Worker for Web Push notifications only.
// No caching, no offline support.
self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  const title = data.title || 'Codex';
  const body  = data.body  || '';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    tag:      data.tag || 'ccm-push',
    data:     data.data || {},
    renotify: true,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  let targetUrl = '/';
  try {
    const target = new URL(e.notification.data?.url || '/', self.location.origin);
    if (target.origin === self.location.origin) {
      targetUrl = `${target.pathname}${target.search}${target.hash}`;
    }
  } catch { /* use safe root fallback */ }
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const w = list.find(c => new URL(c.url).origin === self.location.origin);
      if (!w) return clients.openWindow(targetUrl);
      if (typeof w.navigate === 'function') return w.navigate(targetUrl).then(client => client?.focus());
      return w.focus();
    })
  );
});
