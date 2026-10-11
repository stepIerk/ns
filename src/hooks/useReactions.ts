import { useCallback, useEffect, useRef, useState } from 'react';
import { onValue, ref, remove, set } from 'firebase/database';
import { getRtdb } from '../lib/firebase';
import { reactGet, reactPut } from '../lib/db';

// Палитра как в Telegram. QUICK — двойной тап.
export const REACTION_PALETTE = ['❤️', '👍', '🔥', '🎉', '😢', '😮', '😁'] as const;
export const QUICK_REACTION = '❤️';

/** uid → emoji. Реакции — plaintext-метадата (как presence), без шифрования. */
export type ReactionMap = Record<string, string>;

function sanitize(v: unknown): ReactionMap {
  const map: ReactionMap = {};
  if (v && typeof v === 'object') {
    for (const [uid, e] of Object.entries(v as Record<string, unknown>)) {
      if (typeof e === 'string' && e) map[uid] = e;
    }
  }
  return map;
}

/**
 * Реакции одного сообщения поверх RTDB `reactions/{msgId}/{uid}`.
 * Старт — мгновенно из IDB-кэша (или seed в превью), дальше живой onValue.
 * Тоггл optimistic, при ошибке — откат + reactError (показ тостом).
 * localOnly (превью /test): только локальный стейт, сети нет.
 */
export function useMessageReactions(
  msgId: string,
  myUid: string,
  opts?: { seed?: ReactionMap; localOnly?: boolean },
) {
  const [reactions, setReactions] = useState<ReactionMap>(() => opts?.seed ?? {});
  const [reactError, setReactError] = useState<string | null>(null);
  const mirrorRef = useRef<ReactionMap>(opts?.seed ?? {});
  const localOnly = opts?.localOnly ?? false;

  useEffect(() => {
    if (!msgId || localOnly) return;
    let alive = true;
    // msgId стабилен на время жизни пузыря (key=m.id) — сброс не нужен,
    // начальное состояние уже выставлено через seed/{} в useState выше.
    // Мгновенно из кэша (0 запросов), RTDB догонит.
    reactGet(msgId)
      .then((cached) => {
        if (alive && cached) {
          mirrorRef.current = cached;
          setReactions(cached);
        }
      })
      .catch(() => {});
    const db = getRtdb();
    if (!db) return () => {};
    const r = ref(db, `reactions/${msgId}`);
    const unsub = onValue(
      r,
      (snap) => {
        const map = sanitize(snap.val());
        if (!alive) return;
        mirrorRef.current = map;
        setReactions(map);
        reactPut(msgId, map).catch(() => {});
      },
      (err) => {
        // Раньше провал был немым (permission_denied при кривых правилах).
        // Теперь видно тостом — чинится публикацией правил RTDB из репо.
        if (!alive) return;
        console.warn(
          '[reactions] listen failed',
          err && typeof err === 'object' && 'code' in err ? err.code : err,
        );
        setReactError('Реакции недоступны — проверь правила RTDB');
      },
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [msgId, localOnly]);

  const toggle = useCallback(
    async (emoji: string): Promise<boolean> => {
      if (!msgId) return false;
      if (!REACTION_PALETTE.includes(emoji as (typeof REACTION_PALETTE)[number])) return false;
      setReactError(null);
      const prev = mirrorRef.current;
      const optimistic: ReactionMap = { ...prev };
      if (prev[myUid] === emoji) delete optimistic[myUid];
      else optimistic[myUid] = emoji;
      mirrorRef.current = optimistic;
      setReactions(optimistic);
      if (localOnly) return true;
      const db = getRtdb();
      if (!db) {
        setReactError('Нет соединения — реакция не отправилась');
        // Откат: без сети optimistic невалиден.
        mirrorRef.current = prev;
        setReactions(prev);
        return false;
      }
      try {
        const r = ref(db, `reactions/${msgId}/${myUid}`);
        if (optimistic[myUid] == null) await remove(r);
        else await set(r, optimistic[myUid]);
        reactPut(msgId, optimistic).catch(() => {});
        return true;
      } catch {
        // Откат к последнему серверному состоянию.
        mirrorRef.current = prev;
        setReactions(prev);
        setReactError('Не удалось поставить реакцию');
        return false;
      }
    },
    [msgId, myUid, localOnly],
  );

  return { reactions, toggle, reactError };
}
