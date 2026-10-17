import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Reply,
  Volume2,
  VolumeX,
  X,
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
import { bigEmojiKind } from '../lib/emoji';
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
            : parent.kind === 'video'
              ? '🎥 Кружок'
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
        if (rec.kind === 'video') {
          setRemote({ name: nameOf(rec.senderId), text: '🎥 Кружок' });
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

// ---------- Кружок: плеер ----------

interface VideoBubbleProps {
  m: ChatMessage;
  url: string | null;
  loadError: boolean;
  shape: 'circle' | 'rounded';
  radius: number;
  onRetry: () => void;
  onExpand: () => void;
  uploadProgress?: number;
}

function VideoBubble({
  m,
  url,
  loadError,
  shape,
  radius,
  onRetry,
  onExpand,
  uploadProgress,
}: VideoBubbleProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const totalMs = m.durationMs && m.durationMs > 0 ? m.durationMs : 0;

  // muted ставим свойству императивно: React-атрибут muted не цепляется
  // к свойству, без этого autoplay заблокируется везде.
  const setVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el) {
      try {
        el.muted = true;
      } catch {
        // ignore
      }
      el.play().catch(() => {});
    }
  }, []);

  // Пауза за кадром (батарея), при возврате — play.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          if (v.paused) v.play().catch(() => {});
        } else if (!v.paused) {
          try {
            v.pause();
          } catch {
            // ignore
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [url]);

  // Тап — открыть театр (там звук, пауза и перемотка).
  // Пока кружок грузится (pending) — театр недоступен.
  const openTheater = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (url && !m.pending) onExpand();
  };

  if (loadError) {
    return (
      <div className="photo-error">
        Не удалось загрузить видео
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
    <div
      className="video-wrap"
      style={{ borderRadius: shape === 'circle' ? '50%' : `${radius}px` }}
      onClick={openTheater}
    >
      {url ? (
        <video
          key={url}
          ref={setVideoEl}
          src={url}
          muted
          loop
          playsInline
          autoPlay
          preload="metadata"
          disablePictureInPicture
        />
      ) : (
        <div className="photo-loading video-loading" aria-hidden />
      )}
      {typeof uploadProgress === 'number' && (
        <div className="video-upload-ovl" aria-hidden>
          <span
            className="ring"
            style={{ '--p': String(Math.max(0.03, Math.min(1, uploadProgress))) } as React.CSSProperties}
          />
        </div>
      )}
      <span className="video-dur">{formatVoiceTime(totalMs)}</span>
    </div>
  );
}

// ---------- Театр кружка: листалка с живым следованием ----------

interface TheaterItem {
  m: ChatMessage;
  url: string | null;
}

interface TheaterSlideProps {
  item: TheaterItem;
  shape: 'circle' | 'rounded';
  radius: number;
  active: boolean;
  consumeSwipe: () => boolean;
  onNeedUrl: (id: string) => void;
}

// Один слайд: плеер + свои контролы (состояние живёт в слайде).
function TheaterSlide({ item, shape, radius, active, consumeSwipe, onNeedUrl }: TheaterSlideProps) {
  const { m, url } = item;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const totalMs = m.durationMs && m.durationMs > 0 ? m.durationMs : 0;

  const baseOf = (v: HTMLVideoElement | null): number => {
    const d = v?.duration;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
    return totalMs > 0 ? totalMs / 1000 : 0;
  };

  // Url может догрузиться позже (кружок вне окна рендера) — просим докачать.
  useEffect(() => {
    if (!url) onNeedUrl(m.id);
  }, [url, m.id, onNeedUrl]);

  // Играет только активный слайд; остальные стоят на паузе.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    if (!active) {
      if (!v.paused) {
        try {
          v.pause();
        } catch {
          // ignore
        }
      }
      return;
    }
    try {
      v.muted = false;
    } catch {
      // ignore
    }
    void v.play().then(
      () => {
        setPlaying(true);
        setMuted(false);
      },
      () => {
        try {
          v.muted = true;
        } catch {
          // ignore
        }
        setMuted(true);
        void v.play().then(
          () => setPlaying(true),
          () => setPlaying(false),
        );
      },
    );
  }, [url, active]);

  // Тоггл тапом; клик после свайпа гасим (флаг ставит шелл выше,
  // до корня он не доплывает из-за stopPropagation на плеере).
  const guardedToggle = () => {
    if (consumeSwipe()) return;
    togglePlay();
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      if (v.ended) {
        try {
          v.currentTime = 0;
        } catch {
          // ignore
        }
        setProgress(0);
      }
      void v.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      );
    } else {
      try {
        v.pause();
      } catch {
        // ignore
      }
      setPlaying(false);
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    setMuted(next);
    try {
      v.muted = next;
      if (!next && v.paused) v.play().catch(() => {});
    } catch {
      // ignore
    }
  };

  const seekFrac = (frac: number) => {
    const v = videoRef.current;
    if (!v) return;
    const base = baseOf(v);
    if (base <= 0) return;
    const t = Math.min(0.999, Math.max(0, frac)) * base;
    try {
      v.currentTime = t;
    } catch {
      // ignore
    }
    setProgress(t / base);
  };

  const fracFromClientX = (clientX: number): number | null => {
    const bar = barRef.current;
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return Math.min(0.999, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  };

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    scrubbingRef.current = true;
    const f = fracFromClientX(e.clientX);
    if (f != null) seekFrac(f);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    const f = fracFromClientX(e.clientX);
    if (f != null) seekFrac(f);
  };
  const onBarUp = () => {
    scrubbingRef.current = false;
  };

  return (
    <>
      <div
        className="video-stage-player"
        style={{ borderRadius: shape === 'circle' ? '50%' : `${radius * 2}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          <video
            ref={videoRef}
            src={url}
            playsInline
            preload="auto"
            disablePictureInPicture
            onClick={guardedToggle}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              const base = baseOf(v);
              if (base > 0 && !scrubbingRef.current) setProgress(Math.min(1, v.currentTime / base));
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setProgress(1);
            }}
          />
        ) : (
          <div className="vtheater-loading" aria-label="Загрузка">
            <Loader2 size={30} className="spin" />
          </div>
        )}
        {url && !playing && (
          <button className="vtheater-bigplay" onClick={guardedToggle} aria-label="Смотреть">
            <Play size={34} />
          </button>
        )}
      </div>
      <div
        className="vtheater-controls"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button className="vtheater-btn" onClick={guardedToggle} aria-label={playing ? 'Пауза' : 'Смотреть'}>
          {playing ? <Pause size={19} /> : <Play size={19} />}
        </button>
        <span className="vtheater-time">{formatVoiceTime(progress * totalMs)}</span>
        <div
          className="seekbar"
          ref={barRef}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
        >
          <div className="seekbar-track" aria-hidden>
            <div className="seekbar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
        <span className="vtheater-time">{formatVoiceTime(totalMs)}</span>
        <button className="vtheater-btn" onClick={toggleMute} aria-label={muted ? 'Со звуком' : 'Без звука'}>
          {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
      </div>
    </>
  );
}

interface VideoTheaterProps {
  ids: string[];
  idx: number;
  getItem: (id: string) => { m: ChatMessage; url: string | null } | null;
  shape: 'circle' | 'rounded';
  radius: number;
  onIdx: (i: number) => void;
  onNeedUrl: (id: string) => void;
  onClose: () => void;
}

// Шелл-листалка: трек из трёх слайдов (назад/текущий/вперёд) едет за пальцем,
// на релизе — snap к ближайшему. Тап без сдвига — закрыть.
export function VideoTheater({
  ids,
  idx,
  getItem,
  shape,
  radius,
  onIdx,
  onNeedUrl,
  onClose,
}: VideoTheaterProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [vw, setVw] = useState(0);
  const [drag, setDrag] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const navRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (snapTimer.current) clearTimeout(snapTimer.current);
    },
    [],
  );

  useEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const sync = () => setVw(el.clientWidth);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowIds = useMemo(() => {
    const out: string[] = [];
    if (idx > 0) out.push(ids[idx - 1]!);
    out.push(ids[idx]!);
    if (idx < ids.length - 1) out.push(ids[idx + 1]!);
    return out;
  }, [ids, idx]);
  const curPos = idx > 0 ? 1 : 0;

  // Флаг свайпа гасит ближайший клик (тоггл play / закрытие).
  const consumeSwipe = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return true;
    }
    return false;
  };

  const snapBack = () => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    setSnapping(true);
    setDrag(0);
    snapTimer.current = setTimeout(() => setSnapping(false), 250);
  };

  const animateTo = (newIdx: number) => {
    if (newIdx === idx || newIdx < 0 || newIdx >= ids.length) return;
    const W = viewRef.current?.clientWidth ?? 0;
    if (W <= 0) {
      onIdx(newIdx);
      return;
    }
    if (snapTimer.current) clearTimeout(snapTimer.current);
    setSnapping(true);
    setDrag((idx - newIdx) * W);
    snapTimer.current = setTimeout(() => {
      setSnapping(false);
      setDrag(0);
      onIdx(newIdx);
    }, 250);
  };

  const onRootDown = (e: React.PointerEvent) => {
    if (!e.isPrimary || snapping) return;
    suppressClickRef.current = false;
    navRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onRootMove = (e: React.PointerEvent) => {
    const n = navRef.current;
    if (!n || !e.isPrimary || snapping) return;
    const dx = e.clientX - n.x;
    const dy = e.clientY - n.y;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) n.moved = true;
    if (Math.abs(dx) < Math.abs(dy)) return; // вертикаль не тянем
    const W = viewRef.current?.clientWidth ?? 0;
    let d = dx;
    const atStart = idx === 0;
    const atEnd = idx === ids.length - 1;
    if ((d > 0 && atStart) || (d < 0 && atEnd)) d *= 0.35;
    if (W > 0) d = Math.max(-W * 1.1, Math.min(W * 1.1, d));
    setDrag(d);
  };
  const onRootUp = (e: React.PointerEvent) => {
    const n = navRef.current;
    navRef.current = null;
    if (!n || !n.moved || snapping) return;
    const dx = e.clientX - n.x;
    const dy = e.clientY - n.y;
    suppressClickRef.current = true;
    const W = viewRef.current?.clientWidth ?? 0;
    const th = Math.max(70, W * 0.15);
    if (Math.abs(dx) > th && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0 && idx < ids.length - 1) animateTo(idx + 1);
      else if (dx > 0 && idx > 0) animateTo(idx - 1);
      else snapBack();
    } else {
      snapBack();
    }
  };
  const onRootClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClose();
  };

  return (
    <div
      className="video-theater"
      onPointerDown={onRootDown}
      onPointerMove={onRootMove}
      onPointerUp={onRootUp}
      onPointerCancel={() => {
        navRef.current = null;
      }}
      onClick={onRootClick}
    >
      <button
        className="vtheater-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Закрыть"
      >
        <X size={20} />
      </button>
      {ids.length > 1 && (
        <span className="vtheater-count" aria-hidden>
          {idx + 1} / {ids.length}
        </span>
      )}
      {idx > 0 && (
        <button
          className="vtheater-nav prev"
          onClick={(e) => {
            e.stopPropagation();
            animateTo(idx - 1);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Предыдущий кружок"
        >
          <ChevronLeft size={26} />
        </button>
      )}
      {idx < ids.length - 1 && (
        <button
          className="vtheater-nav next"
          onClick={(e) => {
            e.stopPropagation();
            animateTo(idx + 1);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Следующий кружок"
        >
          <ChevronRight size={26} />
        </button>
      )}
      <div className="vtheater-viewport" ref={viewRef}>
        <div
          className={`vtheater-track${snapping ? ' snap' : ''}`}
          style={{ transform: `translateX(${-vw * curPos + drag}px)` }}
        >
          {windowIds.map((id, i) => {
            const it = getItem(id);
            if (!it) return <div className="vtheater-slide" key={id} />;
            return (
              <div className="vtheater-slide" key={id}>
                <TheaterSlide
                  item={it}
                  shape={shape}
                  radius={radius}
                  active={i === curPos}
                  consumeSwipe={consumeSwipe}
                  onNeedUrl={onNeedUrl}
                />
              </div>
            );
          })}
        </div>
      </div>
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
  onSparkReplay: (m: ChatMessage) => void;
  onExpandVideo: (m: ChatMessage) => void;
  videoShape: 'circle' | 'rounded';
  videoRadius: number;
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
    onSparkReplay,
    onExpandVideo,
    videoShape,
    videoRadius,
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
    // Лонг-пресс — фото (тап занят viewer'ом), spark (тап занят реплеем)
    // и видео (тап включает звук). У остального меню по тапу.
    if (
      (m.kind === 'photo' || m.kind === 'video' || (m.kind === 'text' && m.spark === true)) &&
      !m.pending
    ) {
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

  // Тап: текст и голосовое — меню, spark — реплей салюта (меню лонг-прессом),
  // дабл-тап везде — быстрый ❤️. Тапы по картинке и кнопкам плеера не доходят.
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
    // Spark: тап — локальный реплей салюта (меню — лонг-прессом).
    if (m.kind === 'text' && m.spark === true) {
      if (m.text) {
        onCloseMenu();
        onSparkReplay(m);
      }
      return;
    }
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

  // Big emoji: только смайлы — без рамки пузыря (стекло тоже снимаем,
  // иначе color-mix вернёт фон). Цитата/реакции/свайпы работают как обычно.
  const bigKind = m.kind === 'text' && !m.decryptError ? bigEmojiKind(m.text) : null;

  const contentNode =
    m.kind === 'text' ? (
      <div
        className={`bubble${glass && !bigKind ? ' glass' : ''}${bigKind ? ` bubble-nobg ${bigKind === 'huge' ? 'emoji-huge' : 'emoji-mid'}` : ''}${m.spark === true ? ' spark-glow' : ''}`}
      >
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
    ) : m.kind === 'video' ? (
      <div className="bubble bubble-nobg">
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
            return (
              <VideoBubble
                m={m}
                url={null}
                loadError={false}
                shape={videoShape}
                radius={videoRadius}
                onRetry={() => {}}
                onExpand={() => {}}
              />
            );
          }
          if (st.status === 'error') {
            return (
              <VideoBubble
                m={m}
                url={null}
                loadError
                shape={videoShape}
                radius={videoRadius}
                onRetry={() => onRetryPhoto(m)}
                onExpand={() => {}}
              />
            );
          }
          return (
            <VideoBubble
              m={m}
              url={st.url}
              loadError={false}
              shape={videoShape}
              radius={videoRadius}
              onRetry={() => {}}
              onExpand={() => onExpandVideo(m)}
              uploadProgress={st.uploading ? (st.progress ?? 0) : undefined}
            />
          );
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
