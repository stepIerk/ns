import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { User } from 'firebase/auth';
import {
  Check,
  CheckCheck,
  Clock,
  ImagePlus,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Settings,
  WifiOff,
  X,
} from 'lucide-react';
import { useChat } from '../hooks/useChat';
import { useMedia } from '../hooks/useMedia';
import { isOnline, isTyping, lastSeenText, usePresence } from '../hooks/usePresence';
import { assetDel, assetGet, assetPut, dbStats, storageEstimate } from '../lib/db';
import { prepareImage } from '../lib/image';
import type { LocalSettings } from '../lib/settings';
import { disablePush, enablePush, hasPushSubscription, registerSW } from '../lib/push';
import SettingsSheet from './SettingsSheet';
import type { ChatMessage } from '../types';

interface Props {
  user: User;
  roomKey: CryptoKey;
  onShowKey: () => void;
  onLogout: () => void;
  onWipeDevice: () => void;
  settings: LocalSettings;
  updateSettings: (patch: Partial<LocalSettings>) => void;
  resetAppearance: () => void;
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

export default function Chat({
  user,
  roomKey,
  onShowKey,
  onLogout,
  onWipeDevice,
  settings,
  updateSettings,
  resetAppearance,
}: Props) {
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

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
  // Локальное оформление: обои и аватар из IDB-ассетов.
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // SW регистрируем заранее (не в жесте), чтобы в жесте остались только
  // permission + subscribe — это требование iOS PWA.
  useEffect(() => {
    registerSW().catch(() => {});
    hasPushSubscription().then(setPushOn).catch(() => {});
  }, []);

  // Клавиатура iOS, профессиональная схема:
  // - document не скроллится вообще (см. CSS html/body) — Safari нечего «подбрасывать»;
  // - высота клавиатуры экспортируется в --kb-inset (resize+scroll visualViewport),
  //   композер поднимается через margin с transition — плавно, как в TG;
  // - preemptive focus без автоскролла; blur+сброс при сворачивании.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb-inset', `${Math.round(inset)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('focusin', sync);
      window.removeEventListener('focusout', sync);
      root.style.removeProperty('--kb-inset');
    };
  }, []);

  useEffect(() => {
    const reset = () => {
      inputRef.current?.blur();
      window.scrollTo(0, 0);
      document.documentElement.style.removeProperty('--kb-inset');
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') reset();
    };
    window.addEventListener('pagehide', reset);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', reset);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Упреждающий фокус без автоскролла Safari (иначе он панорамирует страницу).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onTouch = (e: TouchEvent) => {
      if (document.activeElement !== el) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      }
    };
    el.addEventListener('touchstart', onTouch, { passive: false });
    return () => el.removeEventListener('touchstart', onTouch);
  }, []);

  // Обои + аватар из локальных ассетов.
  useEffect(() => {
    let alive = true;
    assetGet('wallpaper')
      .then((a) => {
        if (alive && a) setWallpaperUrl(URL.createObjectURL(a.blob));
      })
      .catch(() => {});
    assetGet('avatar')
      .then((a) => {
        if (alive && a) setAvatarUrl(URL.createObjectURL(a.blob));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
    },
    [wallpaperUrl],
  );
  useEffect(
    () => () => {
      if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    },
    [avatarUrl],
  );

  const pickWallpaper = (f: File) => {
    void prepareImage(f, 1600, 0.82)
      .then(({ bytes, mime }) => assetPut('wallpaper', new Blob([bytes], { type: mime }), mime))
      .then(() => assetGet('wallpaper'))
      .then((a) => {
        if (a) {
          setWallpaperUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(a.blob);
          });
        }
      })
      .catch(() => {});
  };
  const clearWallpaper = () => {
    setWallpaperUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    assetDel('wallpaper').catch(() => {});
  };
  const pickAvatar = (f: File) => {
    void prepareImage(f, 256, 0.8)
      .then(({ bytes, mime }) => assetPut('avatar', new Blob([bytes], { type: mime }), mime))
      .then(() => assetGet('avatar'))
      .then((a) => {
        if (a) {
          setAvatarUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(a.blob);
          });
        }
      })
      .catch(() => {});
  };
  const clearAvatar = () => {
    setAvatarUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    assetDel('avatar').catch(() => {});
  };

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

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Не дёргаем ленту, если пользователь читает старое.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!bootedRef.current || nearBottom) {
      bottomRef.current?.scrollIntoView({
        behavior: bootedRef.current ? 'smooth' : 'auto',
        block: 'end',
      });
      bootedRef.current = true;
    }
  }, [visible.length]);

  // Дебаг кэша: локальные счётчики, сети не касаемся.
  useEffect(() => {
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
  }, [visible.length]);

  // Escape закрывает шторку.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

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
      // Клавиатура остаётся: фокус не отдаём (кнопка не забирает его — см. onPointerDown ниже).
      inputRef.current?.focus();
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
  const shownError = error ?? (media.mediaError);

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

  const initial = (settings.peerName.trim()[0] ?? '?').toUpperCase();
  const swInfo =
    'serviceWorker' in navigator
      ? navigator.serviceWorker.controller
        ? 'sw: active (офлайн-шелл готов)'
        : 'sw: нет контроля (открой онлайн и перезапусти)'
      : 'sw: не поддерживается';
  const debugLines = [
    `online=${String(online)} fromCache=${String(fromCache)} snapshots=${snapCount} msgs=${visible.length}`,
    `api=${apiBase}`,
    ...(pushStatus ? [pushStatus] : []),
    ...(snapError ? [`snap err: ${snapError}`] : []),
    ...(cacheInfo ? [cacheInfo] : []),
    swInfo,
    'iOS: сообщения в фоне приходят только пушем.',
  ];

  // Кастомные цвета пузырей поверх темы (null = цвет темы).
  const themeVars = {
    ...(settings.bubbleColorMine ? { '--bubble-mine': settings.bubbleColorMine } : null),
    ...(settings.bubbleColorTheirs ? { '--bubble-theirs': settings.bubbleColorTheirs } : null),
    ...(settings.bubbleColorMine ? { '--glass-mine': settings.bubbleColorMine } : null),
    ...(settings.bubbleColorTheirs ? { '--glass-theirs': settings.bubbleColorTheirs } : null),
  } as CSSProperties;

  // iOS: кнопка не должна забирать фокус у input, иначе клавиатура схлопнется.
  const keepFocus = { onPointerDown: (e: React.PointerEvent) => e.preventDefault() };

  return (
    <div className="chat" style={themeVars}>
      {wallpaperUrl && (
        <div className="wallpaper-layer" style={{ backgroundImage: `url("${wallpaperUrl}")` }} />
      )}
      <header className="topbar">
        <div className="avatar" style={avatarUrl ? undefined : { background: settings.avatarColor }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt={settings.peerName} />
          ) : (
            <span style={{ color: '#fff' }}>{initial}</span>
          )}
        </div>
        <div className="top-title">
          <strong>{settings.peerName}</strong>
          <span className="top-sub">
            <span className={`dot${peerOnline ? '' : ' off'}`} />
            <Lock size={11} />
            {peerStatus}
          </span>
        </div>
        <div className="top-actions">
          <button
            className="icon-btn"
            onClick={() => setSheetOpen(true)}
            title="Настройки"
            aria-label="Настройки"
          >
            <Settings size={19} />
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
          iOS: для уведомлений открой сайт с иконки «На экране Домой», затем включи push в
          настройках.
        </div>
      )}
      {shownError && <div className="error" style={{ margin: '8px 12px 0' }}>{shownError}</div>}

      <div className="list" ref={listRef}>
        {visible.length > 0 && <div ref={topSentinelRef} aria-hidden />}
        {items.slice(-renderCount).map(({ m, day, showDay, grouped }) => {
          const mine = m.senderId === user.uid;
          const glass = mine ? settings.bubbleGlassMine : settings.bubbleGlassTheirs;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="day-divider">{day}</div>}
              <div className={`msg${mine ? ' mine' : ' theirs'}${grouped ? ' grouped' : ''}`}>
                {m.kind === 'text' ? (
                  <div className={`bubble${glass ? ' glass' : ''}`}>
                    {m.decryptError ? <i>Не удалось расшифровать</i> : m.text}
                    <div className="meta">
                      {timeLabel(m.createdAtMs)}
                      {m.pending ? (
                        m.status === 'error' ? (
                          <button
                            {...keepFocus}
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
                  <div className={`bubble bubble-photo${glass ? ' glass' : ''}`}>
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
          onPointerDown={(e) => e.preventDefault()}
          title="Отправить фото"
          aria-label="Отправить фото"
        >
          {media.photoBusy ? <Loader2 size={20} className="spin" /> : <ImagePlus size={20} />}
        </button>
        <input
          ref={inputRef}
          className="composer-input"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setTyping(v.trim().length > 0);
          }}
          placeholder="Сообщение"
          maxLength={4000}
          enterKeyHint="send"
        />
        <button
          type="submit"
          className="send-btn"
          disabled={sending || !text.trim()}
          onPointerDown={(e) => e.preventDefault()}
          aria-label="Отправить"
        >
          {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
        </button>
      </form>

      {media.viewer && (
        <div className="modal viewer" onClick={() => media.closeViewer()}>
          <img src={media.viewer.url} alt="фото" onClick={(e) => e.stopPropagation()} />
          <button className="viewer-close" onClick={() => media.closeViewer()}>
            <X size={16} /> Закрыть
          </button>
        </div>
      )}

      <SettingsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        settings={settings}
        update={updateSettings}
        resetAppearance={resetAppearance}
        avatarUrl={avatarUrl}
        onPickAvatar={pickAvatar}
        onClearAvatar={clearAvatar}
        wallpaperUrl={wallpaperUrl}
        onPickWallpaper={pickWallpaper}
        onClearWallpaper={clearWallpaper}
        pushOn={pushOn}
        pushBusy={pushBusy}
        onTogglePush={() => void onTogglePush()}
        pushStatus={pushStatus}
        email={user.email ?? ''}
        onLogout={onLogout}
        onShowKey={onShowKey}
        onWipeDevice={onWipeDevice}
        debugLines={debugLines}
      />
    </div>
  );
}
