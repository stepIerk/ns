import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { b64ToBytes, decryptBytes, encryptBytes } from '../lib/crypto';
import { prepareImage } from '../lib/image';
import { authedPost } from '../lib/api';
import type { ChatMessage, MessageDoc } from '../types';

// Медиа-флоу (возвращён из старой реализации, почищен):
// prepareImage → encryptBytes → upload-init → PUT ciphertext напрямую в Google
// (сервер байтов не видит) → setDoc media → addDoc photo-message → push.
// Скачивание — прокси чанками 1МБ через API, сервер видит только шифротекст.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_CHUNK = 1024 * 1024;
const WRITE_TIMEOUT_MS = 30000;

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
  const [viewer, setViewer] = useState<{ url: string; mime: string } | null>(null);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(roomKey);
  useEffect(() => {
    keyRef.current = roomKey;
  }, [roomKey]);

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
        const put = await fetch(sessionUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: cipher,
        });
        if (!put.ok) throw new Error(`Drive upload failed: ${put.status}`);
        const meta = (await put.json()) as { id?: string };
        if (!meta.id) throw new Error('Drive не вернул id файла');
        const fb = getFirebase();
        if (!fb) throw new Error('Firebase не настроен');
        await withTimeout(
          setDoc(doc(fb.db, 'media', mediaId), {
            messageId: clientMessageId,
            driveFileId: meta.id,
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
            driveFileId: meta.id,
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

  const openPhoto = useCallback(async (m: ChatMessage) => {
    if (!m.iv || !m.driveFileId) return;
    setViewerLoading(m.id);
    setError(null);
    try {
      const cipher = await downloadCipher(m);
      const plain = await decryptBytes(keyRef.current, m.iv, cipher);
      const blob = new Blob([plain], { type: m.mimeType ?? 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      setViewer((v) => {
        if (v) URL.revokeObjectURL(v.url);
        return { url, mime: m.mimeType ?? 'image/jpeg' };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть фото');
    } finally {
      setViewerLoading(null);
    }
  }, []);

  const closeViewer = useCallback(() => {
    setViewer((v) => {
      if (v) URL.revokeObjectURL(v.url);
      return null;
    });
  }, []);

  return { photoBusy, viewer, viewerLoading, mediaError: error, sendPhoto, openPhoto, closeViewer };
}
