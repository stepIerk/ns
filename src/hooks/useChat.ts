import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  endBefore,
  getDocs,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { decryptText, encryptText } from '../lib/crypto';
import { authedPost } from '../lib/api';
import {
  MSG_CAP,
  msgNewest,
  msgOlderThan,
  msgPut,
  msgTrim,
  type StoredMsg,
} from '../lib/db';
import type { ChatMessage, MessageDoc, ReplyTarget } from '../types';

// v1: только текстовые сообщения, один долгоживущий onSnapshot.
// Внутри листенера НИКАКИХ записей — иначе loop "snapshot -> write -> snapshot"
// и бесконечные POST в Write/channel. Receipts (deliveredAt/readAt) выкл.
const PAGE_SIZE = 50; // живой хвост слушателя (дельты после первой синхронизации)
const BOOT_N = 200; // мгновенный старт из IDB
const HISTORY_PAGE = 60; // страница истории по скроллу вверх
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

/** Firestore-док → плоская IDB-запись (без Timestamp-объектов). */
function docToRecord(id: string, v: MessageDoc): StoredMsg {
  return {
    id,
    ts: tsOf(v),
    clientMessageId: v.clientMessageId ?? id,
    senderId: v.senderId ?? '?',
    kind: v.kind === 'voice' ? 'voice' : v.kind === 'video' ? 'video' : v.kind === 'photo' ? 'photo' : 'text',
    ciphertext: v.ciphertext,
    iv: v.iv,
    mediaId: v.mediaId,
    driveFileId: v.driveFileId,
    mimeType: v.mimeType,
    size: v.size,
    durationMs: v.durationMs,
    waveform: v.waveform,
    spark: v.spark,
    replyToId: v.replyToId,
    replyToSenderId: v.replyToSenderId,
    replyToClientId: v.replyToClientId,
  };
}

/** Плоская запись → ссылка цитаты (если есть родитель). */
function recordReplyTo(r: StoredMsg): ChatMessage['replyTo'] {
  if (!r.replyToId || !r.replyToSenderId) return undefined;
  return {
    id: r.replyToId,
    clientMessageId: r.replyToClientId,
    senderId: r.replyToSenderId,
  };
}

/** IDB-записи → ChatMessage (расшифровка текста; только чтение, записей нет). */
async function recordsToChat(
  key: CryptoKey,
  records: StoredMsg[],
  userUid: string,
  seen: number | null,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const r of records) {
    const mine = r.senderId === userUid;
    const st: ChatMessage['status'] = mine && seen != null && r.ts <= seen ? 'read' : 'sent';
    if (r.kind !== 'text') {
      const mediaKind = r.kind === 'voice' ? 'voice' : r.kind === 'video' ? 'video' : 'photo';
      out.push({
        id: r.id,
        clientMessageId: r.clientMessageId,
        senderId: r.senderId,
        createdAtMs: r.ts,
        kind: mediaKind,
        mediaId: r.mediaId,
        driveFileId: r.driveFileId,
        mimeType: r.mimeType,
        size: r.size,
        iv: r.iv,
        durationMs: r.durationMs,
        waveform: r.waveform,
        spark: r.spark,
        text: r.kind === 'photo' ? '[фото — нажмите открыть]' : undefined,
        status: st,
        replyTo: recordReplyTo(r),
      });
      continue;
    }
    const base: ChatMessage = {
      id: r.id,
      clientMessageId: r.clientMessageId,
      senderId: r.senderId,
      createdAtMs: r.ts,
      kind: 'text',
      status: st,
      replyTo: recordReplyTo(r),
      spark: r.spark,
    };
    try {
      if (r.ciphertext && r.iv) base.text = await decryptText(key, r.iv, r.ciphertext);
      else base.decryptError = true;
    } catch {
      base.decryptError = true;
    }
    out.push(base);
  }
  return out;
}

/** Слияние по id (входящие побеждают), порядок по времени. Быстрый путь — append. */
function mergeSorted(prev: ChatMessage[], add: ChatMessage[]): ChatMessage[] {
  if (add.length === 0) return prev;
  if (prev.length === 0) return [...add].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const prevMax = prev[prev.length - 1]?.createdAtMs ?? -Infinity;
  const addMin = Math.min(...add.map((m) => m.createdAtMs));
  if (addMin >= prevMax) {
    const known = new Set(prev.map((m) => m.id));
    const fresh = add.filter((m) => !known.has(m.id));
    if (fresh.length === 0) return prev;
    return [...prev, ...fresh];
  }
  const map = new Map(prev.map((m) => [m.id, m] as const));
  for (const m of add) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function useChat(userUid: string, roomKey: CryptoKey, peerSeenTs?: number) {
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
  // seenTs пира для галочек: читаем через ref, чтобы не переподписывать rooms.
  const peerSeenRef = useRef<number | null>(peerSeenTs ?? null);
  useEffect(() => {
    peerSeenRef.current = peerSeenTs ?? null;
  }, [peerSeenTs]);
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

  // Зеркало состояния для loadOlder (старт из IDB + постраничная история).
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  });

  // Мгновенный старт из локального IDB-зеркала (0 запросов к серверу).
  // Живой слушатель ниже догонит дельту и смержит по id.
  useEffect(() => {
    let alive = true;
    msgNewest(BOOT_N)
      .then((rows) => recordsToChat(keyRef.current, rows, userUid, peerSeenRef.current))
      .then((booted) => {
        if (alive && booted.length > 0) setMessages(booted);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userUid]);

  // Единственная подписка. Живёт пока открыт чат (>30с, без churn).
  // Сервер шлёт только хвост limitToLast (первичная синхронизация + дельты),
  // историю вверх грузим только явным loadOlder по скроллу.
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
        // Только чтение + расшифровка + зеркало в IDB. Записей здесь нет по design'у.
        void (async () => {
          const records = docs.map((d) => docToRecord(d.id, d.data() as MessageDoc));
          // IDB-зеркало (best-effort, рендер не ждёт) + FIFO-трим.
          msgPut(records).catch(() => {});
          msgTrim(MSG_CAP).catch(() => {});
          const out = await recordsToChat(key, records, userUid, peerSeenRef.current);
          setMessages((prev) => mergeSorted(prev, out));
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

  // Дотягиваем галочки, когда seenTs пира вырос между снапшотами rooms.
  // Чисто локальный пересчёт статусов — записей нет, loop невозможен.
  useEffect(() => {
    if (peerSeenTs == null) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (m.pending || m.senderId !== userUid || m.status === 'read') return m;
        if (m.createdAtMs <= peerSeenTs) {
          changed = true;
          return { ...m, status: 'read' as const };
        }
        return m;
      });
      return changed ? next : prev;
    });
  }, [peerSeenTs, userUid]);

  // История вверх: сначала IDB-зеркало (0 запросов), при упоре в дно кэша —
  // одна страничная выборка с сервера курсором (биллится один раз и
  // складывается в IDB). Пустая/короткая страница = истории больше нет.
  // Возвращает сколько сообщений добавилось.
  const exhaustedRef = useRef(false);
  const loadOlder = useCallback(async (): Promise<number> => {
    const list = messagesRef.current;
    if (list.length === 0) return 0;
    const oldest = list[0];
    if (!oldest) return 0;
    let rows: StoredMsg[];
    try {
      rows = await msgOlderThan(oldest.createdAtMs, oldest.id, HISTORY_PAGE);
    } catch {
      rows = [];
    }
    if (rows.length < HISTORY_PAGE && !exhaustedRef.current) {
      try {
        const fb = getFirebase();
        if (fb) {
          const page = query(
            collection(fb.db, 'rooms', 'main', 'messages'),
            orderBy('clientTs', 'asc'),
            endBefore(oldest.createdAtMs),
            limitToLast(HISTORY_PAGE),
          );
          const snap = await getDocs(page);
          if (snap.docs.length < HISTORY_PAGE) exhaustedRef.current = true;
          const fresh = snap.docs.map((d) => docToRecord(d.id, d.data() as MessageDoc));
          if (fresh.length > 0) {
            msgPut(fresh).catch(() => {});
            // IDB-ряд + серверный ряд (дедуп по id при merge).
            const have = new Set(rows.map((r) => r.id));
            rows = [...fresh.filter((r) => !have.has(r.id)), ...rows].sort((a, b) =>
              a.ts !== b.ts ? a.ts - b.ts : a.id < b.id ? -1 : 1,
            );
          }
        }
      } catch {
        // Офлайн/ошибка — отдаём что нашли в IDB (возможно, 0).
      }
    }
    if (rows.length === 0) return 0;
    const mapped = await recordsToChat(keyRef.current, rows, userUid, peerSeenRef.current).catch(
      () => [] as ChatMessage[],
    );
    if (mapped.length === 0) return 0;
    setMessages((prev) => mergeSorted(prev, mapped));
    return mapped.length;
  }, [userUid]);

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
    async (body: string, opts?: { replyTo?: ReplyTarget; spark?: boolean }): Promise<void> => {
      const text = body.trim();
      if (!text) return;
      setError(null);
      const clientMessageId = crypto.randomUUID();
      const replyTo = opts?.replyTo;
      const spark = opts?.spark === true;
      const optimistic: ChatMessage = {
        id: `local-${clientMessageId}`,
        clientMessageId,
        senderId: userUid,
        createdAtMs: Date.now(),
        kind: 'text',
        text,
        status: 'sending',
        pending: true,
        replyTo,
        ...(spark ? { spark: true as const } : null),
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
            ...(spark ? { spark: true as const } : null),
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

  // Оптимистичные медиа (кружки): useMedia кладёт pending-сообщение сюда,
  // эхо из Firestore убирает его само (эффект выше — матч по clientMessageId).
  const addPending = useCallback((m: ChatMessage) => {
    setPending((p) => (p.some((x) => x.clientMessageId === m.clientMessageId) ? p : [...p, m]));
  }, []);

  const dropPending = useCallback((clientMessageId: string) => {
    setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
  }, []);

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
    addPending,
    dropPending,
    notifyMessage: firePush,
    loadOlder,
  };
}
