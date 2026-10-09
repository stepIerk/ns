import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { decryptText, encryptText } from '../lib/crypto';
import { authedPost } from '../lib/api';
import type { ChatMessage, MessageDoc } from '../types';

// v1: только текстовые сообщения, один долгоживущий onSnapshot.
// Внутри листенера НИКАКИХ записей — иначе loop "snapshot -> write -> snapshot"
// и бесконечные POST в Write/channel. Receipts (deliveredAt/readAt) выкл.
const PAGE_SIZE = 50;
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

function tsOf(d: MessageDoc): number {
  if (typeof d.clientTs === 'number') return d.clientTs;
  return Date.now();
}

export function useChat(userUid: string, roomKey: CryptoKey) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [error, setError] = useState<string | null>(null);
  const [snapCount, setSnapCount] = useState(0);
  const [snapError, setSnapError] = useState<string | null>(null);
  // Последний результат триггера пуша — видно в ?debug=1.
  // На iOS это главный канал доставки (листенер в фоне спит),
  // а раньше ошибка тут глоталась в console.warn и была не видна.
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  const keyRef = useRef(roomKey);
  useEffect(() => {
    keyRef.current = roomKey;
  }, [roomKey]);
  const seenPushRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => {
      window.removeEventListener('online', f);
      window.removeEventListener('offline', f);
    };
  }, []);

  // Единственная подписка. Живёт пока открыт чат (>30с, без churn).
  useEffect(() => {
    const fb = getFirebase();
    if (!fb) return;
    const q = query(
      collection(fb.db, 'rooms', 'main', 'messages'),
      orderBy('clientTs', 'asc'),
      limitToLast(PAGE_SIZE),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setFromCache(snap.metadata.fromCache);
        setSnapCount((c) => c + 1);
        setSnapError(null);
        const key = keyRef.current;
        const docs = snap.docs;
        // Только чтение + расшифровка. Записей здесь нет по design'у.
        void (async () => {
          const out: ChatMessage[] = [];
          for (const d of docs) {
            const v = d.data() as MessageDoc;
            // Медиа: photo-доки несут метадату для useMedia (открытие по тапу).
            if ((v.kind ?? 'text') !== 'text') {
              out.push({
                id: d.id,
                clientMessageId: v.clientMessageId ?? d.id,
                senderId: v.senderId ?? '?',
                createdAtMs: tsOf(v),
                kind: 'photo',
                mediaId: v.mediaId,
                driveFileId: v.driveFileId,
                mimeType: v.mimeType,
                size: v.size,
                iv: v.iv,
                text: '[фото — нажмите открыть]',
                status: 'sent',
              });
              continue;
            }
            const base: ChatMessage = {
              id: d.id,
              clientMessageId: v.clientMessageId ?? d.id,
              senderId: v.senderId ?? '?',
              createdAtMs: tsOf(v),
              kind: 'text',
              status: 'sent',
            };
            try {
              if (v.ciphertext && v.iv) base.text = await decryptText(key, v.iv, v.ciphertext);
              else base.decryptError = true;
            } catch {
              base.decryptError = true;
            }
            out.push(base);
          }
          setMessages(out);
        })();
      },
      (e) => {
        setSnapError(`${e.code ?? '?'}: ${e.message}`.slice(0, 300));
      },
    );
    return () => unsub();
  }, [userUid]);

  // Чистим optimistic-pending, когда серверное эхо уже в messages.
  useEffect(() => {
    if (pending.length === 0 || messages.length === 0) return;
    const serverIds = new Set(messages.map((m) => m.clientMessageId));
    setPending((p) => p.filter((m) => !serverIds.has(m.clientMessageId)));
  }, [messages, pending.length]);

  const firePush = useCallback(async (messageId: string) => {
    if (seenPushRef.current.has(messageId)) return;
    seenPushRef.current.add(messageId);
    try {
      const res = await authedPost<{ ok?: boolean; skipped?: string; cleaned?: boolean }>(
        '/api/push',
        { messageId },
      );
      if (res?.skipped) setPushStatus(`push skipped: ${res.skipped}`);
      else if (res?.cleaned) setPushStatus('push: подписка протухла, удалена');
      else setPushStatus(`push ok (${messageId.slice(0, 6)}…)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPushStatus(`push FAIL: ${msg.slice(0, 160)}`);
      console.warn('[push] trigger failed', e);
    }
  }, []);

  const sendText = useCallback(
    async (body: string): Promise<void> => {
      const text = body.trim();
      if (!text) return;
      setError(null);
      const clientMessageId = crypto.randomUUID();
      const optimistic: ChatMessage = {
        id: `local-${clientMessageId}`,
        clientMessageId,
        senderId: userUid,
        createdAtMs: Date.now(),
        kind: 'text',
        text,
        status: 'sending',
        pending: true,
      };
      setPending((p) => [...p, optimistic]);
      try {
        const { ivB64, ctB64 } = await encryptText(keyRef.current, text);
        const fb = getFirebase();
        if (!fb) throw new Error('Firebase не настроен');
        const ref = await withTimeout(
          addDoc(collection(fb.db, 'rooms', 'main', 'messages'), {
            clientMessageId,
            senderId: userUid,
            createdAt: serverTimestamp(),
            clientTs: Date.now(),
            kind: 'text',
            ciphertext: ctB64,
            iv: ivB64,
          } satisfies MessageDoc),
        );
        // pending уберётся эхом из onSnapshot (см. эффект выше),
        // но и тут чистим сразу чтобы не мигало.
        setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
        void firePush(ref.id);
      } catch (e) {
        setPending((p) =>
          p.map((m) =>
            m.clientMessageId === clientMessageId
              ? { ...m, status: 'error', errorText: e instanceof Error ? e.message : 'Ошибка' }
              : m,
          ),
        );
      }
    },
    [userUid, firePush],
  );

  const retryToDraft = useCallback(
    (clientMessageId: string): string | null => {
      const item = pending.find((m) => m.clientMessageId === clientMessageId);
      if (!item?.text) return null;
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      return item.text;
    },
    [pending],
  );

  const visible = [...messages, ...pending].sort((a, b) => a.createdAtMs - b.createdAtMs);

  return {
    visible,
    messagesCount: messages.length,
    pendingCount: pending.length,
    online,
    fromCache,
    error,
    setError,
    snapCount,
    snapError,
    pushStatus,
    apiBase:
      (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ||
      '(same-origin /api)',
    sendText,
    retryToDraft,
    notifyMessage: firePush,
  };
}
