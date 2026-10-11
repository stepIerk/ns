import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  Clock,
  Copy,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Reply,
} from 'lucide-react';
import type { PhotoState } from '../hooks/useMedia';
import {
  QUICK_REACTION,
  REACTION_PALETTE,
  useMessageReactions,
  type ReactionMap,
} from '../hooks/useReactions';
import { decryptText } from '../lib/crypto';
import { msgById } from '../lib/db';
import { VOICE_BARS, formatVoiceTime } from '../lib/voice';
import { getActiveVoiceId, setActiveVoiceId, subscribeVoiceBus } from '../lib/voiceBus';
import type { ChatMessage, ReplyTarget } from '../types';

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function buzz(ms = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // ignore (iOS)
  }
}

// Порог свайпа-ответа и макс. сдвиг (как в TG — короткий сдвиг + иконка).
const SWIPE_THRESHOLD = 48;
const SWIPE_MAX = 72;
const DOUBLE_TAP_MS = 300;
const LONG_PRESS_MS = 500;

// ---------- Цитата внутри пузыря ----------

interface QuoteProps {
  replyTo: ReplyTarget;
  meUid: string;
  peerName: string;
  visibleMap: Map<string, ChatMessage>;
  roomKey?: CryptoKey;
  onJump: (t: ReplyTarget) => void;
}

function ReplyQuote({ replyTo, meUid, peerName, visibleMap, roomKey, onJump }: QuoteProps) {
  const nameOf = (senderId: string) => (senderId === meUid ? 'Вы' : peerName);
  // Синхронный путь — прямо в рендере (без setState в эффекте).
  const direct = useMemo(() => {
    const parent =
      visibleMap.get(replyTo.id) ??
      (replyTo.clientMessageId ? visibleMap.get(`cm:${replyTo.clientMessageId}`) : undefined);
    if (!parent) return null;
    return {
      name: nameOf(parent.senderId),
      text:
        parent.kind === 'photo'
          ? '📷 Фото'
          : parent.kind === 'voice'
            ? '🎤 Голосовое'
            : parent.decryptError
              ? 'Сообщение'
              : truncate(parent.text ?? 'Сообщение', 90),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTo.id, replyTo.clientMessageId, visibleMap, meUid, peerName]);

  // Асинхронный путь (родитель вне окна): IDB → расшифровка → фолбэк.
  // Все setState — только в асинхронных колбэках.
  const [remote, setRemote] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => {
    if (direct || !roomKey) return;
    let alive = true;
    msgById(replyTo.id)
      .then(async (rec) => {
        if (!alive) return;
        if (!rec) {
          setRemote({ name: '', text: 'Сообщение' });
          return;
        }
        if (rec.kind === 'photo') {
          setRemote({ name: nameOf(rec.senderId), text: '📷 Фото' });
          return;
        }
        if (rec.kind === 'voice') {
          setRemote({ name: nameOf(rec.senderId), text: '🎤 Голосовое' });
          return;
        }
        try {
          if (rec.ciphertext && rec.iv) {
            const t = await decryptText(roomKey, rec.iv, rec.ciphertext);
            if (alive) setRemote({ name: nameOf(rec.senderId), text: truncate(t, 90) });
          } else if (alive) {
            setRemote({ name: nameOf(rec.senderId), text: 'Сообщение' });
          }
        } catch {
          if (alive) setRemote({ name: nameOf(rec.senderId), text: 'Сообщение' });
        }
      })
      .catch(() => {
        if (alive) setRemote({ name: '', text: 'Сообщение' });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, roomKey, replyTo.id]);

  const resolved = direct ?? remote ?? (!roomKey ? { name: '', text: 'Сообщение' } : null);
  if (!resolved) return null;
  return (
    <button
      className="quote"
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onJump(replyTo);
      }}
    >
      <span className="quote-bar" />
      <span className="quote-body">
        {resolved.name ? <strong>{resolved.name}</strong> : null}
        <span>{resolved.text}</span>
      </span>
    </button>
  );
}

// ---------- Меню реакций ----------

interface MenuProps {
  myEmoji?: string;
  canCopy: boolean;
  flip: boolean;
  onPick: (emoji: string) => void;
  onCopy: () => void;
}

function ReactionMenu({ myEmoji, canCopy, flip, onPick, onCopy }: MenuProps) {
  return (
    <div
      className={`react-popover${flip ? ' below' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="react-row">
        {REACTION_PALETTE.map((e) => (
          <button
            key={e}
            className={`react-emoji${myEmoji === e ? ' active' : ''}`}
            onPointerDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e)}
            aria-label={`Реакция ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      {canCopy && (
        <button
          className="react-copy"
          onPointerDown={(ev) => ev.preventDefault()}
          onClick={onCopy}
        >
          <Copy size={14} /> Скопировать
        </button>
      )}
    </div>
  );
}

// ---------- Голосовое: плеер ----------

const VOICE_FALLBACK_WAVE: number[] = new Array<number>(VOICE_BARS).fill(0.3);

function durOf(a: HTMLAudioElement | null, metaMs: number): number {
  const d = a?.duration;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return metaMs > 0 ? metaMs / 1000 : 0;
}

interface VoicePlayerProps {
  m: ChatMessage;
  url: string | null;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
}

function VoicePlayer({ m, url, loading, loadError, onRetry }: VoicePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const totalMs = m.durationMs && m.durationMs > 0 ? m.durationMs : 0;
  const bars = m.waveform && m.waveform.length >= 8 ? m.waveform : VOICE_FALLBACK_WAVE;

  // Эксклюзив: заиграл другой пузырь — встаём на паузу.
  useEffect(
    () =>
      subscribeVoiceBus(() => {
        if (getActiveVoiceId() !== m.id) {
          try {
            audioRef.current?.pause();
          } catch {
            // ignore
          }
          setPlaying(false);
        }
      }),
    [m.id],
  );

  useEffect(
    () => () => {
      const a = audioRef.current;
      audioRef.current = null;
      if (a) {
        try {
          a.pause();
          a.removeAttribute('src');
        } catch {
          // ignore
        }
      }
      if (getActiveVoiceId() === m.id) setActiveVoiceId(null);
    },
    [m.id],
  );

  const toggle = () => {
    if (!url || loading || loadError) return;
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = 'auto';
      a.src = url;
      a.ontimeupdate = () => {
        setProgress(Math.min(1, a.currentTime / Math.max(0.01, durOf(a, totalMs))));
      };
      a.onended = () => {
        setPlaying(false);
        setProgress(0);
        if (getActiveVoiceId() === m.id) setActiveVoiceId(null);
      };
      audioRef.current = a;
    }
    const a = audioRef.current;
    if (playing) {
      try {
        a.pause();
      } catch {
        // ignore
      }
      setPlaying(false);
      if (getActiveVoiceId() === m.id) setActiveVoiceId(null);
    } else {
      // play() строго в жесте (иначе iOS не даст звук) — toggle вызывается из onClick.
      if (a.ended) {
        try {
          a.currentTime = 0;
        } catch {
          // ignore
        }
        setProgress(0);
      }
      setActiveVoiceId(m.id);
      a.play().then(
        () => setPlaying(true),
        () => {
          setPlaying(false);
          if (getActiveVoiceId() === m.id) setActiveVoiceId(null);
        },
      );
    }
  };

  const seekFrac = (frac: number) => {
    const a = audioRef.current;
    if (!a) return;
    const base = durOf(a, totalMs);
    if (base <= 0) return;
    const t = Math.min(0.999, Math.max(0, frac)) * base;
    try {
      a.currentTime = t;
    } catch {
      // ignore
    }
    setProgress(t / base);
  };

  if (loadError) {
    return (
      <div className="photo-error">
        Не удалось загрузить голосовое
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          <RefreshCw size={13} /> Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="voice-row">
      <button
        className="voice-play"
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        disabled={!url}
        aria-label={playing ? 'Пауза' : 'Слушать'}
      >
        {loading || !url ? (
          <Loader2 size={17} className="spin" />
        ) : playing ? (
          <Pause size={17} />
        ) : (
          <Play size={17} />
        )}
      </button>
      <div
        className="voice-bars"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          seekFrac((e.clientX - r.left) / Math.max(1, r.width));
          // Тап по волне и мотает, и стартует (как в TG).
          if (!playing && url) toggle();
        }}
      >
        {bars.map((b, i) => (
          <span
            key={i}
            className={i / bars.length <= progress ? 'on' : ''}
            style={{ height: `${Math.round(20 + Math.min(1, Math.max(0, b)) * 80)}%` }}
          />
        ))}
      </div>
      <span className="voice-time">
        {playing ? formatVoiceTime(progress * totalMs) : formatVoiceTime(totalMs)}
      </span>
    </div>
  );
}

// ---------- Пузырь ----------

export interface MessageBubbleProps {
  m: ChatMessage;
  mine: boolean;
  grouped: boolean;
  glass: boolean;
  meUid: string;
  peerName: string;
  roomKey?: CryptoKey;
  photos: Record<string, PhotoState>;
  menuOpen: boolean;
  menuFlip: boolean;
  onOpenMenu: (flip: boolean) => void;
  onCloseMenu: () => void;
  onReply: (m: ChatMessage) => void;
  onJump: (t: ReplyTarget) => void;
  onErrorTap: (m: ChatMessage) => void;
  onRetryPhoto: (m: ChatMessage) => void;
  onOpenViewer: (id: string) => void;
  onCopyText: (text: string) => void;
  notify: (msg: string) => void;
  visibleMap: Map<string, ChatMessage>;
  seedReactions?: ReactionMap;
  reactionsLocalOnly?: boolean;
}

export default function MessageBubble(props: MessageBubbleProps) {
  const {
    m,
    mine,
    grouped,
    glass,
    meUid,
    peerName,
    roomKey,
    photos,
    menuOpen,
    menuFlip,
    onOpenMenu,
    onCloseMenu,
    onReply,
    onJump,
    onErrorTap,
    onRetryPhoto,
    onOpenViewer,
    onCopyText,
    notify,
    visibleMap,
    seedReactions,
    reactionsLocalOnly,
  } = props;

  const { reactions, toggle, reactError } = useMessageReactions(m.pending ? '' : m.id, meUid, {
    seed: seedReactions,
    localOnly: reactionsLocalOnly,
  });

  useEffect(() => {
    if (reactError) notify(reactError);
  }, [reactError, notify]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{ x: number; y: number; lock: 'h' | 'v' | null } | null>(null);
  const [offset, setOffset] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const lastTapRef = useRef(0);
  const suppressClickRef = useRef(false);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPress = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  // Свайп-влево → ответ. Вертикаль отдаём скроллу ленты (pan-y + lock).
  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Новый жест — новый шанс: сбрасываем флаг глотания клика
    // (иначе прерванный свайп съест следующий тап).
    suppressClickRef.current = false;
    gestureRef.current = { x: e.clientX, y: e.clientY, lock: null };
    setSnapping(false);
    // Лонг-пресс — только фото (у текста меню по тапу, картинка занята viewer'ом).
    if (m.kind === 'photo' && !m.pending) {
      longPressRef.current = setTimeout(() => {
        longPressRef.current = null;
        gestureRef.current = null;
        setOffset(0);
        suppressClickRef.current = true;
        buzz(15);
        onOpenMenu(measureFlip());
      }, LONG_PRESS_MS);
    }
  };

  const measureFlip = (): boolean => {
    const el = wrapRef.current;
    const list = el?.closest('.list');
    if (!el || !list) return false;
    return el.getBoundingClientRect().top - list.getBoundingClientRect().top < 250;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || !e.isPrimary) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearLongPress();
    if (!g.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.lock = Math.abs(dx) > Math.abs(dy) && dx < 0 ? 'h' : 'v';
      if (g.lock === 'h') onCloseMenu();
      else {
        gestureRef.current = null;
        return;
      }
    }
    if (g.lock === 'h') {
      if (Math.abs(dx) > 10) suppressClickRef.current = true;
      setOffset(m.pending ? 0 : Math.max(-SWIPE_MAX, Math.min(0, dx)));
    }
  };

  const endGesture = () => {
    clearLongPress();
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || g.lock !== 'h') return;
    setSnapping(true);
    if (offset <= -SWIPE_THRESHOLD && !m.pending) {
      buzz();
      onReply(m);
    }
    setOffset(0);
  };

  // Тап: текст и голосовое — меню, дабл-тап — быстрый ❤️. Тапы по картинке
  // и кнопкам плеера не доходят (stopPropagation), лонг-пресс фото — меню.
  const onBubbleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (m.pending) return;
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      onCloseMenu();
      void toggle(QUICK_REACTION).then((ok) => {
        if (ok) buzz();
      });
      return;
    }
    lastTapRef.current = now;
    // Меню: текст и голосовое — по тапу; фото — лонг-прессом (тап занят viewer'ом).
    if (m.kind === 'text' || m.kind === 'voice') onOpenMenu(measureFlip());
  };

  const distinct = (() => {
    const byEmoji = new Map<string, { count: number; mine: boolean }>();
    for (const [uid, e] of Object.entries(reactions)) {
      const cur = byEmoji.get(e) ?? { count: 0, mine: false };
      cur.count += 1;
      if (uid === meUid) cur.mine = true;
      byEmoji.set(e, cur);
    }
    return [...byEmoji.entries()];
  })();

  const keepFocus = { onPointerDown: (e: React.PointerEvent) => e.preventDefault() };

  const metaNode = (
    <div className="meta">
      {timeLabel(m.createdAtMs)}
      {m.pending ? (
        m.status === 'error' ? (
          <button
            {...keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              onErrorTap(m);
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
  );

  const contentNode =
    m.kind === 'text' ? (
      <div className={`bubble${glass ? ' glass' : ''}`}>
        {m.replyTo && (
          <ReplyQuote
            replyTo={m.replyTo}
            meUid={meUid}
            peerName={peerName}
            visibleMap={visibleMap}
            roomKey={roomKey}
            onJump={onJump}
          />
        )}
        {m.decryptError ? <i>Не удалось расшифровать</i> : m.text}
        {metaNode}
      </div>
    ) : m.kind === 'voice' ? (
      <div className={`bubble bubble-voice${glass ? ' glass' : ''}`}>
        {m.replyTo && (
          <ReplyQuote
            replyTo={m.replyTo}
            meUid={meUid}
            peerName={peerName}
            visibleMap={visibleMap}
            roomKey={roomKey}
            onJump={onJump}
          />
        )}
        {(() => {
          const st = photos[m.id];
          if (!st || st.status === 'loading') {
            return <VoicePlayer m={m} url={null} loading loadError={false} onRetry={() => {}} />;
          }
          if (st.status === 'error') {
            return (
              <VoicePlayer m={m} url={null} loading={false} loadError onRetry={() => onRetryPhoto(m)} />
            );
          }
          return <VoicePlayer m={m} url={st.url} loading={false} loadError={false} onRetry={() => {}} />;
        })()}
        {metaNode}
      </div>
    ) : (
      <div className={`bubble bubble-photo${glass ? ' glass' : ''}`}>
        {m.replyTo && (
          <ReplyQuote
            replyTo={m.replyTo}
            meUid={meUid}
            peerName={peerName}
            visibleMap={visibleMap}
            roomKey={roomKey}
            onJump={onJump}
          />
        )}
        {(() => {
          const st = photos[m.id];
          if (!st || st.status === 'loading') return <div className="photo-loading" />;
          if (st.status === 'error') {
            return (
              <div className="photo-error">
                Не удалось загрузить фото
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetryPhoto(m);
                  }}
                >
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
              onClick={(e) => {
                e.stopPropagation();
                onOpenViewer(m.id);
              }}
            />
          );
        })()}
        {metaNode}
      </div>
    );

  return (
    <div
      className={`msg${mine ? ' mine' : ' theirs'}${grouped ? ' grouped' : ''}`}
      data-mid={m.id}
      data-cmid={m.clientMessageId}
    >
      <div
        className="swipe-wrap"
        ref={wrapRef}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={() => {
          clearLongPress();
          gestureRef.current = null;
          setSnapping(true);
          setOffset(0);
        }}
      >
        <div className="swipe-hint" aria-hidden>
          <Reply size={18} />
        </div>
        <div
          className={`swipe-shift${snapping ? ' snap' : ''}`}
          style={{ transform: `translateX(${offset}px)` }}
          onClick={onBubbleClick}
        >
          {contentNode}
        </div>
        {distinct.length > 0 && (
          <div className="react-pill" onClick={(e) => e.stopPropagation()}>
            {distinct.map(([emoji, info]) => (
              <button
                key={emoji}
                className={`react-pill-item${info.mine ? ' active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  void toggle(emoji);
                }}
                aria-label={`Реакция ${emoji}${info.count > 1 ? ` ×${info.count}` : ''}`}
              >
                <span>{emoji}</span>
                {info.count > 1 && <b>{info.count}</b>}
              </button>
            ))}
          </div>
        )}
        {menuOpen && (
          <ReactionMenu
            myEmoji={typeof reactions[meUid] === 'string' ? reactions[meUid] : undefined}
            canCopy={m.kind === 'text' && !m.decryptError && !!m.text}
            flip={menuFlip}
            onPick={(emoji) => {
              onCloseMenu();
              void toggle(emoji).then((ok) => {
                if (ok) buzz();
              });
            }}
            onCopy={() => {
              onCloseMenu();
              if (m.text) onCopyText(m.text);
            }}
          />
        )}
      </div>
    </div>
  );
}
