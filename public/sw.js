/* Minimal push SW. Payload содержит только messageId — без plaintext.
 * Если чат открыт и видим — будим его сообщением (мгновенный refetch),
 * уведомление не показываем. Иначе — обычное уведомление. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = wins.filter((w) => w.visibilityState === 'visible');
      for (const w of visible) {
        w.postMessage({ type: 'ns-refresh', messageId: (data && data.messageId) || null });
      }
      if (visible.length > 0) return; // клиент сам подтянет сообщение
      const title = 'Новое сообщение';
      const options = {
        body: 'У вас новое зашифрованное сообщение',
        data: data,
        tag: (data && data.messageId) || 'ns-msg',
      };
      await self.registration.showNotification(title, options);
    })(),
  );
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
