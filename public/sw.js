/* Minimal push SW. Payload содержит только messageId — без plaintext. */
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
    data: data,
    tag: (data && data.messageId) || 'ns-msg',
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
      await clients.openWindow('/');
    })(),
  );
});
