import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp as fsTs,
  setDoc,
} from 'firebase/firestore';
import { getFirebase, getRtdb } from '../lib/firebase';
import { onDisconnect, onValue, ref, serverTimestamp as rtdbTs, update } from 'firebase/database';

// Presence для диалога двоих на Realtime Database: онлайн / печатает / seen.
// Почему RTDB, а не Firestore: у Firestore нет onDisconnect, heartbeat писал
// бы ~2 записи/мин (~29% дневной квоты), а RTDB считается по трафику —
// presence-события в сотни байт стоят практически ничего. Heartbeat НЕТ:
// сервер сам отмечает уход через onDisconnect (даже при убитом приложении).
//
// Узел presence/{uid} = {state, lastChanged, typingTs?, seenTs?} — один узел,
// один слушатель на пира вместо трёх. Все операции — update() (merge),
// чтобы onDisconnect/set никогда не затирали соседние поля.
//
// Firestore касается только справочника uid (users/{uid}.ping пишется максимум
// раз за сессию и только при пустом кэше пира; чтение — 2 дока тоже только
// при пустом кэше; дальше peerUid лежит в localStorage и стоит 0 запросов).
const ONLINE_FRESH_MS = 120000; // страховка: state online старше — не считаем
const TYPING_FRESH_MS = 6000; // typingTs свежее — показывает «печатает»
const TYPING_REWRITE_MS = 3000; // не чаще пишем typingTs пока печатаем
const PEER_CACHE_KEY = 'ns-peer-uid';

export interface PeerPresence {
  known: boolean; // есть данные пира (RTDB настроена, узел читается)
  state: 'online' | 'offline' | null;
  lastSeenMs: number | null;
  typingMs: number | null;
  seenTs: number | null; // clientTs последнего сообщения, которое пир отрендерил
}

export function isOnline(p: PeerPresence, now = Date.now()): boolean {
  return p.state === 'online' && p.lastSeenMs != null && now - p.lastSeenMs < ONLINE_FRESH_MS;
}

export function isTyping(p: PeerPresence, now = Date.now()): boolean {
  return p.typingMs != null && now - p.typingMs < TYPING_FRESH_MS;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function lastSeenText(p: PeerPresence, now = Date.now()): string | null {
  if (!p.known || p.lastSeenMs == null) return null;
  const s = Math.max(0, Math.floor((now - p.lastSeenMs) / 1000));
  if (s < 60) return 'был(а) только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `был(а) ${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `был(а) ${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  return (
    'был(а) ' +
    new Date(p.lastSeenMs).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  );
}

function loadCachedPeer(myUid: string): string | null {
  try {
    const v = localStorage.getItem(PEER_CACHE_KEY);
    return v && v !== myUid ? v : null;
  } catch {
    return null;
  }
}

export function usePresence(myUid: string): {
  presence: PeerPresence;
  setTyping: (active: boolean) => void;
  markSeen: (clientTs: number) => void;
} {
  const [presence, setPresence] = useState<PeerPresence>({
    known: false,
    state: null,
    lastSeenMs: null,
    typingMs: null,
    seenTs: null,
  });
  const [peerUid, setPeerUid] = useState<string | null>(() => loadCachedPeer(myUid));
  const typingActive = useRef(false);
  const lastTypingWrite = useRef(0);
  const seenSentRef = useRef(0);

  // Поиск uid собеседника: сначала кэш (0 запросов), иначе 1 запись ping
  // + 1 чтение users (2 дока) — и только один раз, дальше снова кэш.
  useEffect(() => {
    if (peerUid) return;
    const fb = getFirebase();
    if (!fb) return;
    let alive = true;
    void (async () => {
      try {
        await setDoc(doc(fb.db, 'users', myUid), { ping: fsTs() }, { merge: true });
        const snap = await getDocs(query(collection(fb.db, 'users'), limit(10)));
        if (!alive) return;
        const other = snap.docs.map((d) => d.id).find((id) => id !== myUid) ?? null;
        if (other) {
          try {
            localStorage.setItem(PEER_CACHE_KEY, other);
          } catch {
            // ignore
          }
          setPeerUid(other);
        }
      } catch {
        // Нет сети/прав — повторим при следующем монтировании.
      }
    })();
    return () => {
      alive = false;
    };
  }, [myUid, peerUid]);

  // Свой онлайн-статус: при (пере)подключении регистрируем серверный
  // onDisconnect(offline) и только потом пишем online. Уход отметит сервер.
  useEffect(() => {
    const rtdb = getRtdb();
    if (!rtdb) return;
    const myRef = ref(rtdb, `presence/${myUid}`);
    const unsub = onValue(ref(rtdb, '.info/connected'), (snap) => {
      if (snap.val() !== true) return;
      onDisconnect(myRef)
        .update({ state: 'offline', lastChanged: rtdbTs() })
        .then(() => {
          update(myRef, { state: 'online', lastChanged: rtdbTs() }).catch(() => {});
        })
        .catch(() => {});
    });
    // Best-effort: при размонтировании (logout) сразу отметиться офлайн,
    // не ждать серверного onDisconnect.
    return () => {
      unsub();
      update(myRef, { state: 'offline', lastChanged: rtdbTs() }).catch(() => {});
      if (typingActive.current) {
        typingActive.current = false;
        update(myRef, { typingTs: null }).catch(() => {});
      }
    };
  }, [myUid]);

  // Подписка на узел пира (единственный RTDB-слушатель данных).
  useEffect(() => {
    if (!peerUid) return;
    const rtdb = getRtdb();
    if (!rtdb) return;
    return onValue(ref(rtdb, `presence/${peerUid}`), (snap) => {
      const v = snap.val() as {
        state?: unknown;
        lastChanged?: unknown;
        typingTs?: unknown;
        seenTs?: unknown;
      } | null;
      setPresence({
        known: true,
        state: v?.state === 'online' ? 'online' : 'offline',
        lastSeenMs: typeof v?.lastChanged === 'number' ? v.lastChanged : null,
        typingMs: typeof v?.typingTs === 'number' ? v.typingTs : null,
        seenTs: typeof v?.seenTs === 'number' ? v.seenTs : null,
      });
    });
  }, [peerUid]);

  // Тикер, чтобы «печатает»/«в сети» гасли по времени без новых событий.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!presence.known) return;
    const timer = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(timer);
  }, [presence.known]);

  // Сигнал набора: пишем typingTs (троттлинг), снятие — удаляем поле.
  const setTyping = useCallback(
    (active: boolean) => {
      const rtdb = getRtdb();
      if (!rtdb) return;
      const now = Date.now();
      const myRef = ref(rtdb, `presence/${myUid}`);
      if (active) {
        if (typingActive.current && now - lastTypingWrite.current < TYPING_REWRITE_MS) return;
        typingActive.current = true;
        lastTypingWrite.current = now;
        update(myRef, { typingTs: rtdbTs() }).catch(() => {});
      } else {
        if (!typingActive.current) return;
        typingActive.current = false;
        update(myRef, { typingTs: null }).catch(() => {});
      }
    },
    [myUid],
  );

  // Метка прочтения: только рост значения (клиентские часы обеих сторон —
  // Date.now, для сравнения clientTs достаточно). Вызывать при рендере.
  const markSeen = useCallback(
    (clientTs: number) => {
      if (clientTs <= seenSentRef.current) return;
      const rtdb = getRtdb();
      if (!rtdb) return;
      update(ref(rtdb, `presence/${myUid}`), { seenTs: clientTs })
        .then(() => {
          seenSentRef.current = clientTs;
        })
        .catch(() => {});
    },
    [myUid],
  );

  return { presence, setTyping, markSeen };
}
