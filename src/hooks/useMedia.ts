import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { b64ToBytes, bufToB64, decryptBytes, encryptBytes } from '../lib/crypto';
import { prepareImage } from '../lib/image';
import { authedPost, getMaxChunk } from '../lib/api';
import { blobGet, blobPut } from '../lib/db';
import type { ChatMessage, MessageDoc, ReplyTarget } from '../types';
import { computeVoiceWave } from '../lib/voice';

// Медиа-флоу:
// prepareImage → encryptBytes → upload-init → N × upload-chunk (base64, 1МБ)
// через Yandex-функцию → setDoc media → addDoc photo-message → push.
// Браузер к Google напрямую НЕ ходит. Скачивание — прокси чанками 1МБ,
// сервер видит только шифротекст.
//
// Фото подгружаются САМИ (ensurePhotos): очередь с пулом, расшифровка,
// objectURL кэшируется — в ленте картинки видны сразу, тапать не надо.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 30000;
// Параллельных скачиваний файлов: бережём лимит конкурентных вызовов функции.
const MAX_PARALLEL_DOWNLOADS = 3;
// Параллельных чанков внутри одного файла (скачивание).
const DOWNLOAD_WORKERS = 3;
// Чуть ниже execution-timeout функции (30с): живая, но медленная функция
// успеет ответить 504 с диагнозом; срабатывает только на true-зависаниях.
const MEDIA_TIMEOUT_MS = 25000;

export type PhotoState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; uploading?: boolean; progress?: number }
  | { status: 'error' };

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
  // size — размер ШИФРОтекста (plaintext + 16Б тег AES-GCM), поэтому +запас.
  if (!m.driveFileId || !m.iv || total <= 0 || total > MAX_PHOTO_BYTES + 1024) {
    throw new Error('bad photo metadata');
  }
  const chunkSize = await getMaxChunk();
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < total; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize - 1, total - 1) });
  }
  // Чанки качаем параллельно: раньше каждый мегабайт ждал полного
  // round-trip через функцию, теперь файл едет пулом в 3 потока.
  const parts: Uint8Array[] = new Array(ranges.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < ranges.length) {
      const i = next;
      next += 1;
      const r = ranges[i]!;
      const { data } = await authedPost<{ data: string; total: number }>(
        '/api/media/download',
        {
          driveFileId: m.driveFileId,
          start: r.start,
          end: r.end,
        },
        { timeoutMs: MEDIA_TIMEOUT_MS },
      );
      const chunk = b64ToBytes(data);
      if (chunk.length !== r.end - r.start + 1) throw new Error('chunk size mismatch');
      parts[i] = chunk;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_WORKERS, ranges.length) }, () => worker()),
  );
  let received = 0;
  for (const p of parts) received += p.length;
  const cipher = new Uint8Array(received);
  let off = 0;
  for (const p of parts) {
    cipher.set(p, off);
    off += p.length;
  }
  return cipher.buffer as ArrayBuffer;
}

// Заливка шифротекста в Drive через сервер (resumable, строго по порядку).
// Чанк берём максимально допустимый сервером: меньше round-trip'ов —
// короткие кружки уезжают ОДНИМ запросом. onProgress — доля 0..1.
// Позицию каждого следующего чанка берём у сервера: Google может подтвердить
// чанк лишь частично и сервер вернёт фактическую точку продолжения (next).
async function uploadCipherBytes(
  sessionUrl: string,
  bytes: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const chunkSize = await getMaxChunk();
  const total = bytes.byteLength;
  let pos = 0;
  let driveFileId = '';
  while (pos < total) {
    const end = Math.min(pos + chunkSize - 1, total - 1);
    const r = await authedPost<{ done: boolean; fileId?: string; next?: number }>(
      '/api/media/upload-chunk',
      { sessionUrl, start: pos, end, total, data: bufToB64(bytes.subarray(pos, end + 1)) },
      { timeoutMs: MEDIA_TIMEOUT_MS },
    );
    onProgress?.(Math.min(1, (end + 1) / total));
    if (r.done) {
      driveFileId = r.fileId ?? '';
      break;
    }
    const nextPos = typeof r.next === 'number' ? r.next : end + 1;
    if (nextPos <= pos) throw new Error('Загрузка не продвинулась — попробуй ещё раз');
    pos = nextPos;
  }
  if (!driveFileId) throw new Error('Drive не вернул id файла');
  return driveFileId;
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
  // Отправляемые кружки (pending): blobURL в ленте до эха из Firestore.
  const pendingUploadsRef = useRef<Map<string, { pendingId: string; url: string; createdAt: number }>>(
    new Map(),
  );

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
        const mime = m.mimeType ?? 'image/jpeg';
        // Сначала локальный кэш (0 запросов, мгновенно).
        if (m.mediaId) {
          const hit = await blobGet(m.mediaId).catch(() => null);
          if (hit) {
            urlsRef.current.set(m.id, URL.createObjectURL(hit.blob));
            photosRef.current[m.id] = { status: 'ready', url: urlsRef.current.get(m.id)! };
            publish();
            return;
          }
        }
        const cipher = await downloadCipher(m);
        const plain = await decryptBytes(keyRef.current, m.iv ?? '', cipher);
        const blob = new Blob([plain], { type: mime });
        // Кладём в кэш (FIFO 2 ГБ внутри; при переполнении — мимо, только память).
        if (m.mediaId) blobPut(m.mediaId, blob, mime).catch(() => {});
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

  // Поставить вложения в очередь автозагрузки (фото + голосовые + кружочки:
  // скачивание и расшифровка одинаковые; идемпотентно, StrictMode-safe).
  const ensurePhotos = useCallback(
    (msgs: ChatMessage[]) => {
      let added = false;
      for (const m of msgs) {
        if ((m.kind !== 'photo' && m.kind !== 'voice' && m.kind !== 'video') || !m.iv || !m.driveFileId) continue;
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
    async (file: File, opts?: { replyTo?: ReplyTarget }) => {
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
          { timeoutMs: MEDIA_TIMEOUT_MS },
        );
        // Заливка шифротекста чанками через сервер (лимит запроса к функции 3.5МБ,
        // размер чанка — из health сервера, base64 укладывается с запасом).
        // Сервер доливает чанки в resumable-сессию Drive своим PUT с Content-Range.
        const driveFileId = await uploadCipherBytes(sessionUrl, new Uint8Array(cipher));
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
        const replyTo = opts?.replyTo;
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
            ...(replyTo
              ? {
                  replyToId: replyTo.id,
                  replyToSenderId: replyTo.senderId,
                  ...(replyTo.clientMessageId
                    ? { replyToClientId: replyTo.clientMessageId }
                    : null),
                }
              : null),
          } satisfies MessageDoc),
        );
        notifyMessage(ref.id);
        // Своё фото — сразу в локальный кэш (перекачивать с сервера не надо).
        blobPut(mediaId, new Blob([plain], { type: mime }), mime).catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось отправить фото');
      } finally {
        setPhotoBusy(false);
      }
    },
    [userUid, notifyMessage],
  );

  // Голосовое: та же цепочка, что у фото (шифр → Drive чанками → media → message).
  // Waveform считаем из blob (decode), длительность — decode || время записи.
  const sendVoice = useCallback(
    async (blob: Blob, mime: string, recordedMs: number, opts?: { replyTo?: ReplyTarget }) => {
      setError(null);
      setPhotoBusy(true);
      const clientMessageId = crypto.randomUUID();
      const mediaId = crypto.randomUUID();
      try {
        if (blob.size > MAX_PHOTO_BYTES) throw new Error('Голосовое больше 10 МБ');
        const plainBuf = await blob.arrayBuffer();
        if (plainBuf.byteLength === 0) throw new Error('Пустая запись');
        const { waveform, durationMs } = await computeVoiceWave(blob).catch(() => ({
          waveform: [] as number[],
          durationMs: 0,
        }));
        const totalMs = durationMs > 0 ? durationMs : recordedMs;
        const { ivB64, cipher } = await encryptBytes(keyRef.current, plainBuf);
        const { sessionUrl } = await authedPost<{ sessionUrl: string }>(
          '/api/media/upload-init',
          { mediaId, mimeType: mime, size: cipher.byteLength },
          { timeoutMs: MEDIA_TIMEOUT_MS },
        );
        const driveFileId = await uploadCipherBytes(sessionUrl, new Uint8Array(cipher));
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
        const replyTo = opts?.replyTo;
        const ref = await withTimeout(
          addDoc(collection(fb.db, 'rooms', 'main', 'messages'), {
            clientMessageId,
            senderId: userUid,
            createdAt: serverTimestamp(),
            clientTs: Date.now(),
            kind: 'voice',
            mediaId,
            driveFileId,
            mimeType: mime,
            size: cipher.byteLength,
            iv: ivB64,
            durationMs: totalMs,
            waveform,
            ...(replyTo
              ? {
                  replyToId: replyTo.id,
                  replyToSenderId: replyTo.senderId,
                  ...(replyTo.clientMessageId
                    ? { replyToClientId: replyTo.clientMessageId }
                    : null),
                }
              : null),
          } satisfies MessageDoc),
        );
        notifyMessage(ref.id);
        // Своё — сразу в локальный кэш (перекачивать не надо).
        blobPut(mediaId, new Blob([plainBuf], { type: mime }), mime).catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось отправить голосовое');
      } finally {
        setPhotoBusy(false);
      }
    },
    [userUid, notifyMessage],
  );

  // Кружок с оптимистичным пузырём: запись заканчивается — кружок СРАЗУ
  // играет в ленте (локальный blobURL), на кольце — прогресс заливки.
  // Эхо из Firestore подменяет pending на настоящее сообщение (clientMessageId
  // тот же), а картинка при этом берётся мгновенно из IDB-кэша (blobPut ещё
  // до сети) — без мигания и без перекачки с сервера.
  const sendVideo = useCallback(
    async (
      blob: Blob,
      mime: string,
      recordedMs: number,
      opts?: {
        replyTo?: ReplyTarget;
        addPending?: (m: ChatMessage) => void;
        dropPending?: (clientMessageId: string) => void;
      },
    ) => {
      setError(null);
      const clientMessageId = crypto.randomUUID();
      const mediaId = crypto.randomUUID();
      const pendingId = `local-${clientMessageId}`;
      const url = URL.createObjectURL(blob);
      pendingUploadsRef.current.set(clientMessageId, {
        pendingId,
        url,
        createdAt: Date.now(),
      });
      urlsRef.current.set(pendingId, url);
      photosRef.current[pendingId] = { status: 'ready', url, uploading: true, progress: 0 };
      publish();
      const replyTo = opts?.replyTo;
      opts?.addPending?.({
        id: pendingId,
        clientMessageId,
        senderId: userUid,
        createdAtMs: Date.now(),
        kind: 'video',
        durationMs: recordedMs,
        status: 'sending',
        pending: true,
        replyTo,
      });
      try {
        if (blob.size > MAX_PHOTO_BYTES) throw new Error('Видео больше 10 МБ');
        const plainBuf = await blob.arrayBuffer();
        if (plainBuf.byteLength === 0) throw new Error('Пустая запись');
        // В кэш сразу (до сети): эхо после addDoc должно собраться локально.
        blobPut(mediaId, new Blob([plainBuf], { type: mime }), mime).catch(() => {});
        const { ivB64, cipher } = await encryptBytes(keyRef.current, plainBuf);
        const { sessionUrl } = await authedPost<{ sessionUrl: string }>(
          '/api/media/upload-init',
          { mediaId, mimeType: mime, size: cipher.byteLength },
          { timeoutMs: MEDIA_TIMEOUT_MS },
        );
        const driveFileId = await uploadCipherBytes(sessionUrl, new Uint8Array(cipher), (f) => {
          const st = photosRef.current[pendingId];
          if (st?.status === 'ready' && st.uploading) {
            photosRef.current[pendingId] = { ...st, progress: f };
            publish();
          }
        });
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
            kind: 'video',
            mediaId,
            driveFileId,
            mimeType: mime,
            size: cipher.byteLength,
            iv: ivB64,
            durationMs: recordedMs,
            ...(replyTo
              ? {
                  replyToId: replyTo.id,
                  replyToSenderId: replyTo.senderId,
                  ...(replyTo.clientMessageId
                    ? { replyToClientId: replyTo.clientMessageId }
                    : null),
                }
              : null),
          } satisfies MessageDoc),
        );
        notifyMessage(ref.id);
        // Заливка закончилась — кольцо прогресса снимаем, кружок дожидается эха.
        const st = photosRef.current[pendingId];
        if (st?.status === 'ready') {
          photosRef.current[pendingId] = { status: 'ready', url: st.url };
          publish();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось отправить видео');
        opts?.dropPending?.(clientMessageId);
      }
    },
    [userUid, notifyMessage, publish],
  );

  const openViewer = useCallback(
    (id: string) => {
      const st = photosRef.current[id];
      if (st?.status === 'ready') setViewerId(id);
    },
    [],
  );

  const closeViewer = useCallback(() => setViewerId(null), []);

  // Чистка оптимистичных кружков: как только pending исчез из ленты
  // (эхо пришло или отправка упала) — снимаем локальный blobURL и запись
  // прогресса. Двухсекундный грейс защищает от гонки «publish до addPending».
  const syncPendingUploads = useCallback(
    (aliveClientMessageIds: Set<string>) => {
      let changed = false;
      for (const [cmId, up] of pendingUploadsRef.current) {
        if (aliveClientMessageIds.has(cmId) || Date.now() - up.createdAt < 2000) continue;
        pendingUploadsRef.current.delete(cmId);
        delete photosRef.current[up.pendingId];
        if (urlsRef.current.get(up.pendingId) === up.url) {
          urlsRef.current.delete(up.pendingId);
          try {
            URL.revokeObjectURL(up.url);
          } catch {
            // ignore
          }
        }
        changed = true;
      }
      if (changed) publish();
    },
    [publish],
  );

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
    sendVoice,
    sendVideo,
    ensurePhotos,
    retryPhoto,
    openViewer,
    closeViewer,
    syncPendingUploads,
  };
}
