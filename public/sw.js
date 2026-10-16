/* ns-messenger SW v4. Меняй версию при правках, иначе iOS залипнет на старом SW. */
const SW_VERSION = 'v4';

/* Прекэш app shell (index.html, JS, CSS, иконки): собирается на билде
 * через vite-plugin-pwa (injectManifest подставляет __WB_MANIFEST).
 * Только статика из сборки — запросы данных (Firestore/RTDB/API) не
 * перехватываются и всегда идут в сеть, офлайн-данные лежат в IDB. */
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { loadRoomKey } from '../src/lib/keystore';
import { decryptText } from '../src/lib/crypto';
import { formatVoiceTime } from '../src/lib/voice';
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

/* Push для PWA (iOS 16.4+ через APNs, остальные через FCM/WebPush).
 * Payload: messageId + kind + шифротекст (если влез в лимит пуша) — без plaintext.
 * Текст расшифровывает сам SW комнатным ключом из IDB: E2E не нарушен,
 * сервер/Apple/Google видят лишь шифротекст. Длинные тексты и всё, что не
 * расшифровалось, показываются заглушкой по kind (полный текст — в чате).
 * Важно для Safari: notification показываем в том же push-событии (waitUntil);
 * расшифровка локальная (~мс), с капой 1.5с — дальше фолбэк-текст.
 */
function pushFallbackBody(data) {
  if (!data) return 'У вас новое зашифрованное сообщение';
  if (data.kind === 'photo') return '📷 Фото';
  if (data.kind === 'voice') {
    return typeof data.durationMs === 'number' && data.durationMs > 0
      ? `🎤 Голосовое (${formatVoiceTime(data.durationMs)})`
      : '🎤 Голосовое сообщение';
  }
  return 'У вас новое зашифрованное сообщение';
}

async function decryptPushText(data) {
  try {
    if (!data || data.kind !== 'text') return null;
    if (typeof data.ciphertext !== 'string' || typeof data.iv !== 'string') return null;
    const key = await loadRoomKey();
    if (!key) return null;
    const text = await decryptText(key, data.iv, data.ciphertext);
    return text && text.trim() ? text.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      let body = pushFallbackBody(data);
      try {
        const text = await Promise.race([
          decryptPushText(data),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (text) body = text;
      } catch {
        // ignore — body уже фолбэк
      }
      await self.registration.showNotification('Новое сообщение', {
        body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        data: data,
        tag: (data && data.messageId) || 'ns-msg',
        renotify: true,
      });
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
