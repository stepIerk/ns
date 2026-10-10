import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { b64ToBytes, bufToB64, decryptBytes, encryptBytes } from '../lib/crypto';
import { prepareImage } from '../lib/image';
import { authedPost } from '../lib/api';
import type { ChatMessage, MessageDoc } from '../types';

// Медиа-флоу:
// prepareImage → encryptBytes → upload-init → N × upload-chunk (base64, 1МБ)
// через Yandex-функцию → setDoc media → addDoc photo-message → push.
// Браузер к Google напрямую НЕ ходит. Скачивание — прокси чанками 1МБ,
// сервер видит только шифротекст.
//
// Фото подгружаются САМИ (ensurePhotos): очередь с пулом, расшифровка,
// objectURL кэшируется — в ленте картинки видны сразу, тапать не надо.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_CHUNK = 1024 * 1024;
const UPLOAD_CHUNK = 1024 * 1024;
const WRITE_TIMEOUT_MS = 30000;
// Параллельных скачиваний: бережём лимит конкурентных вызовов функции.
const MAX_PARALLEL_DOWNLOADS = 4;

export type PhotoState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' };

function withTimeout<T>(p: Promise<T>, ms = WRITE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Превышено ожидание ответа (${ms / 1000}с) — проверь соединение`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function downloadCipher(m: ChatMessage): Promise<ArrayBuffer> {
  const total = m.size ?? 0;
  if (!m.driveFileId || !m.iv || total <= 0 || total > MAX_PHOTO_BYTES) {
    throw new Error('bad photo metadata');
  }
  const parts: Uint8Array[] = [];
  let received = 0;
  for (let start = 0; start < total; start += DOWNLOAD_CHUNK) {
    const end = Math.min(start + DOWNLOAD_CHUNK - 1, total - 1);
    const { data } = await authedPost<{ data: string; total: number }>('/api/media/download', {
      driveFileId: m.driveFileId,
      start,
      end,
    });
    const chunk = b64ToBytes(data);
    parts.push(chunk);
    received += chunk.length;
  }
  const cipher = new Uint8Array(received);
  let off = 0;
  for (const p of parts) {
    cipher.set(p, off);
    off += p.length;
  }
  return cipher.buffer as ArrayBuffer;
}

export function useMedia(
  userUid: string,
  roomKey: CryptoKey,
  notifyMessage: (messageId: string) => void,
) {
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photos, setPhotos] = useState<Record<string, PhotoState>>({});
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(roomKey);
  useEffect(() => {
    keyRef.current = roomKey;
  }, [roomKey]);

  // photosRef — источник правды (setPhotos только публикует в React).
  const photosRef = useRef<Record<string, PhotoState>>({});
  const queuedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<ChatMessage[]>([]);
  const activeRef = useRef(0);
  const urlsRef = useRef<Map<string, string>>(new Map());

  // Чистим objectURL при размонтировании.
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  const publish = useCallback(() => {
    setPhotos({ ...photosRef.current });
  }, []);

  // pump вызывает сам себя из finally — через ref, чтобы не ссылаться
  // на себя до объявления (и чтобы очередь двигалась всегда актуальной версией).
  const pumpRef = useRef<() => void>(() => {});

  const runOne = useCallback(
    async (m: ChatMessage) => {
      try {
        const cipher = await downloadCipher(m);
        const plain = await decryptBytes(keyRef.current, m.iv ?? '', cipher);
        const blob = new Blob([plain], { type: m.mimeType ?? 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        urlsRef.current.set(m.id, url);
        photosRef.current[m.id] = { status: 'ready', url };
      } catch {
        photosRef.current[m.id] = { status: 'error' };
      }
      publish();
    },
    [publish],
  );

  const pump = useCallback(() => {
    while (activeRef.current < MAX_PARALLEL_DOWNLOADS && queueRef.current.length > 0) {
      const m = queueRef.current.shift();
      if (!m) break;
      activeRef.current += 1;
      void runOne(m).finally(() => {
        activeRef.current -= 1;
        queuedRef.current.delete(m.id);
        pumpRef.current();
      });
    }
  }, [runOne]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // Поставить фото в очередь автозагрузки (идемпотентно, StrictMode-safe).
  const ensurePhotos = useCallback(
    (msgs: ChatMessage[]) => {
      let added = false;
      for (const m of msgs) {
        if (m.kind !== 'photo' || !m.iv || !m.driveFileId) continue;
        if (photosRef.current[m.id] || queuedRef.current.has(m.id)) continue;
        queuedRef.current.add(m.id);
        photosRef.current[m.id] = { status: 'loading' };
        queueRef.current.push(m);
        added = true;
      }
      if (!added) return;
      publish();
      pump();
    },
    [publish, pump],
  );

  const retryPhoto = useCallback(
    (m: ChatMessage) => {
      delete photosRef.current[m.id];
      queuedRef.current.delete(m.id);
      publish();
      ensurePhotos([m]);
    },
    [ensurePhotos, publish],
  );

  const sendPhoto = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.type.startsWith('image/')) {
        setError('Пока поддерживаются только изображения');
        return;
      }
      setPhotoBusy(true);
      const clientMessageId = crypto.randomUUID();
      const mediaId = crypto.randomUUID();
      try {
        const { bytes: plain, mime } = await prepareImage(file);
        if (plain.byteLength > MAX_PHOTO_BYTES) {
          throw new Error('Фото больше 10 МБ даже после сжатия');
        }
        const { ivB64, cipher } = await encryptBytes(keyRef.current, plain);
        const { sessionUrl } = await authedPost<{ sessionUrl: string }>(
          '/api/media/upload-init',
          { mediaId, mimeType: mime, size: cipher.byteLength },
        );
        // Заливка шифротекста чанками через сервер (лимит запроса к функции 3.5МБ,
        // чанк 1МБ → ~1.37МБ base64 + JSON — с запасом). Сервер доливает чанки
        // в resumable-сессию Drive своим PUT с Content-Range.
        const bytes = new Uint8Array(cipher);
        const total = bytes.byteLength;
        let driveFileId = '';
        for (let start = 0; start < total; start += UPLOAD_CHUNK) {
          const end = Math.min(start + UPLOAD_CHUNK - 1, total - 1);
          const r = await authedPost<{ done: boolean; fileId?: string }>(
            '/api/media/upload-chunk',
            { sessionUrl, start, end, total, data: bufToB64(bytes.slice(start, end + 1)) },
          );
          if (r.done) driveFileId = r.fileId ?? '';
        }
        if (!driveFileId) throw new Error('Drive не вернул id файла');
        const fb = getFirebase();
        if (!fb) throw new Error('Firebase не настроен');
        await withTimeout(
          setDoc(doc(fb.db, 'media', mediaId), {
            messageId: clientMessageId,
            driveFileId,
            size: cipher.byteLength,
            mimeType: mime,
            iv: ivB64,
            senderId: userUid,
            createdAt: serverTimestamp(),
          }),
        );
        const ref = await withTimeout(
          addDoc(collection(fb.db, 'rooms', 'main', 'messages'), {
            clientMessageId,
            senderId: userUid,
            createdAt: serverTimestamp(),
            clientTs: Date.now(),
            kind: 'photo',
            mediaId,
            driveFileId,
            mimeType: mime,
            size: cipher.byteLength,
            iv: ivB64,
          } satisfies MessageDoc),
        );
        notifyMessage(ref.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось отправить фото');
      } finally {
        setPhotoBusy(false);
      }
    },
    [userUid, notifyMessage],
  );

  const openViewer = useCallback(
    (id: string) => {
      const st = photosRef.current[id];
      if (st?.status === 'ready') setViewerId(id);
    },
    [],
  );

  const closeViewer = useCallback(() => setViewerId(null), []);

  // viewer считаем из state (не из ref — ref нельзя читать в рендере).
  const viewerEntry = viewerId ? photos[viewerId] : undefined;
  const viewer =
    viewerEntry?.status === 'ready' ? { url: viewerEntry.url } : null;

  return {
    photoBusy,
    photos,
    viewer,
    mediaError: error,
    sendPhoto,
    ensurePhotos,
    retryPhoto,
    openViewer,
    closeViewer,
  };
}
