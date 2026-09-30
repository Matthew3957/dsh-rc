'use strict';
// dsh-rc service worker: shows Web Push notifications and opens the matching
// session when one is tapped. Keep it dependency-free; the page is plain JS.

const INDEX = './index.html';
const ICON = 'icon-180.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function targetFor(sessionId) {
  return sessionId ? `${INDEX}#s=${encodeURIComponent(sessionId)}` : INDEX;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  event.waitUntil(self.registration.showNotification(data.title || 'dsh-rc', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: self.registration.scope + ICON,
    badge: self.registration.scope + ICON,
    data: { sessionId, url: targetFor(sessionId) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const url = targetFor(sessionId);
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      let parsed;
      try {
        parsed = new URL(client.url);
      } catch {
        continue;
      }
      // Only reuse our own pages (under the worker's scope), never another app on this origin.
      if (parsed.origin !== self.location.origin || !client.url.startsWith(self.registration.scope)) continue;
      await client.focus();
      let navigated = false;
      if ('navigate' in client) {
        try {
          await client.navigate(url);
          navigated = true;
        } catch {
          // Uncontrolled client: fall through to a message.
        }
      }
      if (!navigated) client.postMessage({ type: 'open-session', sessionId });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
