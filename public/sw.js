/* Push SW для PWA (iOS 16.4+ через APNs, остальные через FCM/WebPush).
 * Payload содержит только messageId — без plaintext.
 * Важно для Safari: показываем notification СРАЗУ в push-событии,
 * иначе Safari отзывает permission (invisible push запрещены).
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = 'Новое сообщение';
  const options = {
    body: 'У вас новое зашифрованное сообщение',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: data,
    tag: (data && data.messageId) || 'ns-msg',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) {
          await w.focus();
          return;
        }
      }
      await clients.openWindow(self.registration.scope);
    })(),
  );
});
