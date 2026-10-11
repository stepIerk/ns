import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  ImagePlus,
  Loader2,
  Lock,
  LogOut,
  Moon,
  QrCode,
  RefreshCw,
  Send,
  Settings,
  Sun,
  WifiOff,
  X,
} from 'lucide-react';
import { useChat } from '../hooks/useChat';
import { useMedia } from '../hooks/useMedia';
import { isOnline, isTyping, lastSeenText, usePresence } from '../hooks/usePresence';
import { dbStats, storageEstimate } from '../lib/db';
import { useTheme } from '../lib/theme';
import { ENABLE_MEDIA } from '../lib/flags';
import { disablePush, enablePush, hasPushSubscription, registerSW } from '../lib/push';
import type { ChatMessage } from '../types';

interface Props {
  user: User;
  roomKey: CryptoKey;
  onShowKey: () => void;
  onLogout: () => void;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = window.matchMedia?.('(display-mode: standalone)');
  if (mql?.matches) return true;
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Сегодня';
  if (sameDay(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export default function Chat({ user, roomKey, onShowKey, onLogout }: Props) {
  const { presence, setTyping, markSeen } = usePresence(user.uid);

  const {
    visible,
    online,
    fromCache,
    error,
    setError,
    snapCount,
    snapError,
    pushStatus,
    apiBase,
    sendText,
    retryToDraft,
    notifyMessage,
    loadOlder,
  } = useChat(user.uid, roomKey, presence.seenTs ?? undefined);

  const media = useMedia(user.uid, roomKey, notifyMessage);
  const { theme, toggle } = useTheme();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [debugOpen, setDebugOpen] = useState(
    () => typeof window !== 'undefined' && window.location.search.includes('debug=1'),
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const bootedRef = useRef(false);
  // Окно рендера: DOM держим маленьким (iPhone), полный объём — в IDB/state.
  const [renderCount, setRenderCount] = useState(120);
  const RENDER_STEP = 80;
  const RENDER_MAX = 500; // потолок DOM-узлов; история дальше — в IDB
  // Якорь скролла для бесшовной догрузки вверх.
  const anchorRef = useRef<{ h: number; top: number } | null>(null);
  const [cacheInfo, setCacheInfo] = useState<string | null>(null);

  // SW регистрируем заранее (не в жесте), чтобы в жесте остались только
  // permission + subscribe — это требование iOS PWA.
  useEffect(() => {
    registerSW().catch(() => {});
    hasPushSubscription().then(setPushOn).catch(() => {});
  }, []);

  // Фото подгружаются сами при появлении в ленте (кэш + пул в useMedia).
  useEffect(() => {
    media.ensurePhotos(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Метка прочтения: max отрендеренного clientTs — только рост, только когда
  // вкладка видима (в фоне не помечаем). ~1 RTDB-запись на пачку сообщений.
  const maxTs = visible.length > 0 ? (visible[visible.length - 1]?.createdAtMs ?? 0) : 0;
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  });
  useEffect(() => {
    if (document.visibilityState === 'visible' && maxTs > 0) markSeen(maxTs);
  }, [maxTs, markSeen]);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const list = visibleRef.current;
      if (list.length > 0) markSeen(list[list.length - 1]?.createdAtMs ?? 0);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [markSeen]);

  // Догрузка истории по скроллу вверх: сначала расширяем окно рендера,
  // при упоре — loadOlder (IDB-first, сервер только при дне кэша).
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (loadingOlderRef.current || renderCount >= RENDER_MAX) return;
        const listEl = listRef.current;
        if (listEl) anchorRef.current = { h: listEl.scrollHeight, top: listEl.scrollTop };
        if (visible.length > renderCount) {
          setRenderCount((c) => c + RENDER_STEP);
          return;
        }
        loadingOlderRef.current = true;
        void loadOlder().then((added) => {
          loadingOlderRef.current = false;
          if (added > 0) setRenderCount((c) => c + RENDER_STEP);
          else anchorRef.current = null;
        });
      },
      { root: listRef.current },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length, renderCount, loadOlder]);

  // Применяем якорь после расширения окна (позиция не прыгает).
  useLayoutEffect(() => {
    const el = listRef.current;
    const a = anchorRef.current;
    if (el && a) {
      el.scrollTop = el.scrollHeight - a.h + a.top;
      anchorRef.current = null;
    }
  });

  // Дебаг кэша: локальные счётчики, сети не касаемся.
  useEffect(() => {
    if (!debugOpen) return;
    let alive = true;
    void (async () => {
      try {
        const [s, e] = await Promise.all([dbStats(), storageEstimate()]);
        if (!alive) return;
        const mb = (b: number) => `${(b / 1048576).toFixed(1)} МБ`;
        setCacheInfo(
          `idb: msgs=${s.msgs} blobs=${s.blobs} (${mb(s.bytes)})` +
            (e ? ` · device: ${mb(e.usage)} / ${mb(e.quota)}` : ''),
        );
      } catch {
        if (alive) setCacheInfo('idb: недоступен');
      }
    })();
    return () => {
      alive = false;
    };
  }, [debugOpen, visible.length]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Не дёргаем ленту, если пользователь читает старое (пузырь «печатает» не в счёт).
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!bootedRef.current || nearBottom) {
      bottomRef.current?.scrollIntoView({
        behavior: bootedRef.current ? 'smooth' : 'auto',
        block: 'end',
      });
      bootedRef.current = true;
    }
  }, [visible.length]);

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setText('');
    setTyping(false);
    setSending(true);
    try {
      await sendText(body);
    } finally {
      setSending(false);
    }
  };

  // Вызывается напрямую из onClick — не теряем user gesture для iOS.
  const onTogglePush = async () => {
    setError(null);
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush(user.uid);
        setPushOn(false);
      } else {
        await enablePush(user.uid);
        setPushOn(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Push ошибка');
    } finally {
      setPushBusy(false);
    }
  };

  const offline = !online || fromCache;
  const standalone = isStandalone();
  const shownError = error ?? (ENABLE_MEDIA ? media.mediaError : null);
  const initial = (user.email?.[0] ?? '?').toUpperCase();

  // Статус собеседника (своя связь важнее: без неё всё остальное неизвестно).
  const peerOnline = isOnline(presence) && !offline;
  const peerTyping = isTyping(presence) && !offline;
  const peerStatus = offline
    ? 'переподключение…'
    : peerTyping
      ? 'печатает…'
      : peerOnline
        ? 'в сети'
        : (lastSeenText(presence) ?? 'сквозное шифрование');

  // Разметка ленты (разделители дней, группировка подряд своих) — чисто,
  // без мутаций в рендере: всё выводится из индекса.
  const items = useMemo(
    () =>
      visible.map((m: ChatMessage, i: number) => {
        const day = dayLabel(m.createdAtMs);
        const prev = i > 0 ? visible[i - 1] : undefined;
        const prevDay = prev ? dayLabel(prev.createdAtMs) : '';
        return {
          m,
          day,
          showDay: prevDay !== day,
          grouped: !!prev && prev.senderId === m.senderId && prevDay === day,
        };
      }),
    [visible],
  );

  return (
    <div className="chat">
      <header className="topbar">
        <div className="avatar">{initial}</div>
        <div className="top-title">
          <strong>Личный чат</strong>
          <span className="top-sub">
            <span className={`dot${peerOnline ? '' : ' off'}`} />
            <Lock size={11} />
            {peerStatus}
          </span>
        </div>
        <div className="top-actions">
          <button
            className="icon-btn"
            onClick={toggle}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            aria-label="Переключить тему"
          >
            {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button
            className={`icon-btn${pushOn ? ' active' : ''}`}
            onClick={() => void onTogglePush()}
            disabled={pushBusy}
            title="Push-уведомления"
            aria-label="Push-уведомления"
          >
            {pushOn ? <Bell size={19} /> : <BellOff size={19} />}
          </button>
          <button className="icon-btn" onClick={onShowKey} title="QR ключа" aria-label="QR ключа">
            <QrCode size={19} />
          </button>
          <button
            className={`icon-btn${debugOpen ? ' active' : ''}`}
            onClick={() => setDebugOpen((v) => !v)}
            title="Настройки"
            aria-label="Настройки"
          >
            <Settings size={19} />
          </button>
          <button className="icon-btn" onClick={onLogout} title="Выйти" aria-label="Выйти">
            <LogOut size={19} />
          </button>
        </div>
      </header>

      {offline && (
        <div className="notice">
          <WifiOff size={14} /> Офлайн / переподключение…
        </div>
      )}
      {!standalone && !pushOn && (
        <div className="notice">
          <Bell size={14} /> iOS: откройте с иконки «На экране Домой» и включите push
        </div>
      )}
      {shownError && <div className="error" style={{ margin: '8px 12px 0' }}>{shownError}</div>}
      {debugOpen && (
        <div className="debug">
          <div className="small">
            online={String(online)} fromCache={String(fromCache)} snapshots={snapCount} msgs=
            {visible.length}
          </div>
          <div className="small">api={apiBase}</div>
          {cacheInfo && <div className="small">{cacheInfo}</div>}
          <div className="small">
            {'serviceWorker' in navigator
              ? navigator.serviceWorker.controller
                ? 'sw: active (офлайн-шелл готов)'
                : 'sw: нет контроля (открой онлайн и перезапусти)'
              : 'sw: не поддерживается'}
          </div>
          {pushStatus && <div className="small">{pushStatus}</div>}
          {snapError && <div className="small">snap err: {snapError}</div>}
          <div className="small muted">
            iOS: сообщения в фоне приходят только пушем. Если snap растёт, а пуша нет — смотри
            строку push выше.
          </div>
        </div>
      )}

      <div className="list" ref={listRef}>
        {visible.length > 0 && <div ref={topSentinelRef} aria-hidden />}
        {items.slice(-renderCount).map(({ m, day, showDay, grouped }) => {
          const mine = m.senderId === user.uid;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="day-divider">{day}</div>}
              <div className={`msg${mine ? ' mine' : ' theirs'}${grouped ? ' grouped' : ''}`}>
                {m.kind === 'text' ? (
                  <div className="bubble">
                    {m.decryptError ? <i>Не удалось расшифровать</i> : m.text}
                    <div className="meta">
                      {timeLabel(m.createdAtMs)}
                      {m.pending ? (
                        m.status === 'error' ? (
                          <button
                            onClick={() => {
                              const draft = retryToDraft(m.clientMessageId);
                              if (draft) setText(draft);
                            }}
                          >
                            ошибка · вернуть в ввод
                          </button>
                        ) : (
                          <Clock size={12} />
                        )
                      ) : mine ? (
                        m.status === 'read' ? (
                          <CheckCheck size={13} className="tick-read" />
                        ) : (
                          <Check size={13} />
                        )
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="bubble bubble-photo">
                    {(() => {
                      const st = media.photos[m.id];
                      if (!st || st.status === 'loading') return <div className="photo-loading" />;
                      if (st.status === 'error') {
                        return (
                          <div className="photo-error">
                            Не удалось загрузить фото
                            <button onClick={() => media.retryPhoto(m)}>
                              <RefreshCw size={13} /> Повторить
                            </button>
                          </div>
                        );
                      }
                      return (
                        <img
                          src={st.url}
                          alt="фото"
                          loading="lazy"
                          onClick={() => media.openViewer(m.id)}
                        />
                      );
                    })()}
                    <div className="meta">
                      {timeLabel(m.createdAtMs)}
                      {mine &&
                        (m.status === 'read' ? (
                          <CheckCheck size={13} className="tick-read" />
                        ) : (
                          <Check size={13} />
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {peerTyping && (
          <div className="msg theirs">
            <div className="bubble typing-bubble" aria-live="polite" aria-label="Собеседник печатает">
              <span className="typing-dots">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={(e) => void onSubmit(e)}>
        {ENABLE_MEDIA && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void media.sendPhoto(f);
              }}
            />
            <button
              type="button"
              className="icon-btn"
              disabled={media.photoBusy}
              onClick={() => fileRef.current?.click()}
              title="Отправить фото"
              aria-label="Отправить фото"
            >
              {media.photoBusy ? <Loader2 size={20} className="spin" /> : <ImagePlus size={20} />}
            </button>
          </>
        )}
        <input
          className="composer-input"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setTyping(v.trim().length > 0);
          }}
          placeholder="Сообщение"
          maxLength={4000}
        />
        <button
          type="submit"
          className="send-btn"
          disabled={sending || !text.trim()}
          aria-label="Отправить"
        >
          {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
        </button>
      </form>

      {ENABLE_MEDIA && media.viewer && (
        <div className="modal viewer" onClick={() => media.closeViewer()}>
          <img src={media.viewer.url} alt="фото" onClick={(e) => e.stopPropagation()} />
          <button className="viewer-close" onClick={() => media.closeViewer()}>
            <X size={16} /> Закрыть
          </button>
        </div>
      )}
    </div>
  );
}
