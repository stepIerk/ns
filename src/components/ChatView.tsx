import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  EllipsisVertical,
  Heart,
  Loader2,
  Lock,
  Mic,
  Plus,
  Square,
  SwitchCamera,
  Trash2,
  Video,
  WifiOff,
  X,
} from 'lucide-react';
import type { PhotoState } from '../hooks/useMedia';
import type { ReactionMap } from '../hooks/useReactions';
import { useVoiceRecorder, type VoiceTake } from '../hooks/useVoiceRecorder';
import { useVideoRecorder, type VideoTake } from '../hooks/useVideoRecorder';
import { sparkMarkSeen, sparkWasSeen } from '../lib/db';
import type { LocalSettings } from '../lib/settings';
import { SPARK_SET, effectFor, type SparkEffect } from '../lib/spark';
import {
  CANCEL_DX,
  HOLD_TO_RECORD_MS,
  LIVE_BARS,
  LOCK_DY,
  MIN_VOICE_MS,
  formatVoiceTime,
} from '../lib/voice';
import { MIN_VIDEO_MS, MAX_VIDEO_MS } from '../lib/video';
import MessageBubble, { VideoTheater } from './MessageBubble';
import SettingsSheet from './SettingsSheet';
import SparkOverlay from './SparkOverlay';
import type { ChatMessage, ReplyTarget } from '../types';

/** Презентационный чат: те же компоненты и стили, данные — пропсами.
 * Используют и боевой Chat (хуки), и превью /test (фейковые данные). */
export interface ChatViewProps {
  meUid: string;
  userEmail: string;
  messages: ChatMessage[];
  photos: Record<string, PhotoState>;
  // Собеседник и связь
  peerName: string;
  peerOnline: boolean;
  peerTyping: boolean;
  peerStatusText: string;
  offline: boolean;
  // Ошибки и отправка
  error: string | null;
  sending: boolean;
  photoBusy: boolean;
  viewer: { url: string } | null;
  // Оформление
  settings: LocalSettings;
  updateSettings: (patch: Partial<LocalSettings>) => void;
  resetAppearance: () => void;
  avatarUrl: string | null;
  wallpaperUrl: string | null;
  onPickAvatar: (f: File) => void;
  onClearAvatar: () => void;
  onPickWallpaper: (f: File) => void;
  onClearWallpaper: () => void;
  // Действия
  onSubmitText: (text: string, opts?: { replyTo?: ReplyTarget; spark?: boolean }) => Promise<void>;
  onPickFile: (f: File, opts?: { replyTo?: ReplyTarget }) => void;
  onSendVoice: (
    blob: Blob,
    mime: string,
    recordedMs: number,
    opts?: { replyTo?: ReplyTarget },
  ) => void;
  onSendVideo: (
    blob: Blob,
    mime: string,
    recordedMs: number,
    opts?: { replyTo?: ReplyTarget },
  ) => void;
  onRetryPhoto: (m: ChatMessage) => void;
  onOpenViewer: (id: string) => void;
  onCloseViewer: () => void;
  onRestoreDraft: (clientMessageId: string) => string | null;
  setTypingActive: (active: boolean) => void;
  ensurePhotos: (msgs: ChatMessage[]) => void;
  markSeen: (clientTs: number) => void;
  onLoadOlder: () => Promise<number>;
  // Push и аккаунт
  pushOn: boolean;
  pushBusy: boolean;
  onTogglePush: () => void;
  pushStatus: string | null;
  onShowKey: () => void;
  onLogout: () => void;
  onWipeDevice: () => void;
  debugLines: string[];
  // Ответы/реакции: ключ комнаты для расшифровки цитат вне окна,
  // в превью — seed реакций + локальный режим без RTDB.
  roomKey?: CryptoKey;
  seedReactions?: Record<string, ReactionMap>;
  reactionsLocalOnly?: boolean;
  // Spark: в превью автосалют гасим (реплей по тапу работает).
  disableSparkAuto?: boolean;
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

export default function ChatView(p: ChatViewProps) {
  const {
    meUid,
    userEmail,
    messages: visible,
    photos,
    peerName,
    peerOnline,
    peerTyping,
    peerStatusText,
    offline,
    error: shownError,
    sending,
    photoBusy,
    viewer,
    settings,
    updateSettings,
    resetAppearance,
    avatarUrl,
    wallpaperUrl,
    onPickAvatar,
    onClearAvatar,
    onPickWallpaper,
    onClearWallpaper,
    onSubmitText,
    onPickFile,
    onSendVoice,
    onSendVideo,
    onRetryPhoto,
    onOpenViewer,
    onCloseViewer,
    onRestoreDraft,
    setTypingActive,
    ensurePhotos,
    markSeen,
    onLoadOlder,
    pushOn,
    pushBusy,
    onTogglePush,
    pushStatus,
    onShowKey,
    onLogout,
    onWipeDevice,
    debugLines,
    roomKey,
    seedReactions,
    reactionsLocalOnly,
    disableSparkAuto,
  } = p;

  const [text, setText] = useState('');
  const [localSending, setLocalSending] = useState(false);
  const busy = sending || localSending;
  const [sheetOpen, setSheetOpen] = useState(false);
  // Ответ черновиком + открытое меню реакций (одно на чат) + тост.
  const [replyDraft, setReplyDraft] = useState<ReplyTarget | null>(null);
  const [menuFor, setMenuFor] = useState<{ id: string; flip: boolean } | null>(null);
  const menuForRef = useRef<{ id: string; flip: boolean } | null>(null);
  useEffect(() => {
    menuForRef.current = menuFor;
  });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastShownRef = useRef<string | null>(null);
  const notify = useCallback((msg: string) => {
    // Дедуп: ошибку слушателя кинет каждый из ~120 пузырей — показываем раз.
    if (toastShownRef.current === msg) return;
    toastShownRef.current = msg;
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastShownRef.current = null;
      setToast(null);
    }, 2200);
  }, []);
  // ---------- Spark Emoji: салюты ----------
  // Панель сердечка вместо ввода; тап по эмодзи = мгновенная отправка spark.
  // Автосалют — только получателю при первом просмотре (флаг в IDB),
  // очередь играет по одному; тап по spark-пузырю — локальный реплей.
  const [sparkOpen, setSparkOpen] = useState(false);
  const [sparkQueue, setSparkQueue] = useState<{ key: number; emoji: string; effect: SparkEffect }[]>([]);
  const sparkQueuedRef = useRef<Set<string>>(new Set());
  const sparkKeyRef = useRef(1);
  // Голова очереди играет; конец показа = pop. Отдельного active-стейта нет,
  // чтобы не дёргать setState синхронно в эффекте (хук-линт).
  const sparkHead = sparkQueue[0] ?? null;
  // ---------- Голосовые: запись (стиль Telegram) ----------
  // Тап по кнопке — смена mic/cam; холд mic — запись; слайд вверх — lock,
  // слайд влево — отмена. Отпустил в holding — отправка; в locked пишем дальше.
  const [recMode, setRecMode] = useState<'mic' | 'cam'>('mic');
  const [cancelArmed, setCancelArmed] = useState(false);
  const {
    phase: recPhase,
    elapsedMs: recElapsed,
    start: recStart,
    finish: recFinish,
    lock: recLock,
    cancel: recCancel,
    setBarsEl: recSetBarsEl,
  } = useVoiceRecorder();
  // ---------- Кружочки: запись видео (те же жесты, что у голосовых) ----------
  // Холд cam — запись с живым превью; слайд вверх — lock, влево — отмена.
  // Переворот камеры — кнопкой прямо во время съёмки (смена видеотрека).
  const {
    phase: vdPhase,
    elapsedMs: vdElapsed,
    facing: vdFacing,
    stream: vdStream,
    start: vdStart,
    finish: vdFinish,
    lock: vdLock,
    cancel: vdCancel,
    flip: vdFlip,
  } = useVideoRecorder();
  const vdRecording = vdPhase !== 'idle';
  const recording = recPhase !== 'idle' || vdRecording;
  const vdPhaseRef = useRef(vdPhase);
  useEffect(() => {
    vdPhaseRef.current = vdPhase;
  });
  const recPhaseRef = useRef(recPhase);
  useEffect(() => {
    recPhaseRef.current = recPhase;
  });
  const replyDraftRef = useRef<ReplyTarget | null>(null);
  useEffect(() => {
    replyDraftRef.current = replyDraft;
  });
  const recGesture = useRef<{
    x: number;
    y: number;
    timer?: ReturnType<typeof setTimeout>;
    started: boolean;
    kind: 'voice' | 'video' | null;
  } | null>(null);
  const recBarsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (recPhase === 'idle') return;
    recSetBarsEl(recBarsRef.current);
    return () => recSetBarsEl(null);
  }, [recPhase, recSetBarsEl]);

  const buzzLocal = (ms = 10) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      // ignore (iOS)
    }
  };

  const handleTake = useCallback(
    (take: VoiceTake | null) => {
      setCancelArmed(false);
      if (!take) return;
      if (take.recordedMs < MIN_VOICE_MS || take.blob.size === 0) {
        notify('Слишком короткое — удерживай кнопку дольше');
        return;
      }
      const draft = replyDraftRef.current;
      setReplyDraft(null);
      onSendVoice(take.blob, take.mime, take.recordedMs, draft ? { replyTo: draft } : undefined);
    },
    [notify, onSendVoice],
  );
  const handleTakeRef = useRef(handleTake);
  useEffect(() => {
    handleTakeRef.current = handleTake;
  });

  const handleTakeVideo = useCallback(
    (take: VideoTake | null) => {
      setCancelArmed(false);
      if (!take) return;
      if (take.recordedMs < MIN_VIDEO_MS || take.blob.size === 0) {
        notify('Слишком короткий кружок — удерживай кнопку дольше');
        return;
      }
      const draft = replyDraftRef.current;
      setReplyDraft(null);
      onSendVideo(take.blob, take.mime, take.recordedMs, draft ? { replyTo: draft } : undefined);
    },
    [notify, onSendVideo],
  );
  const handleTakeVideoRef = useRef(handleTakeVideo);
  useEffect(() => {
    handleTakeVideoRef.current = handleTakeVideo;
  });

  // Живое превью кружка: стрим в <video> (зеркалим фронталку).
  const vdPreviewRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = vdPreviewRef.current;
    if (v && vdStream) {
      v.srcObject = vdStream;
      v.play().catch(() => {});
    }
  }, [vdStream]);

  const flipVideo = () => {
    void vdFlip().then((r) => {
      if (!r.ok) notify(r.message ?? 'Не вышло перевернуть камеру');
    });
  };

  const onRecDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Клавиатуру не трогаем (иначе схлопнется); pointer-события идут как шли.
    e.preventDefault();
    // Запись вместо панели spark (кнопка сердца скрыта, состояние сбрасываем).
    setSparkOpen(false);
    if (photoBusy || busy) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // В locked игнорим кнопку (там свои trash/send), иначе тап сменит режим.
    if (recPhaseRef.current !== 'idle' || vdPhaseRef.current !== 'idle') return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const g = { x: e.clientX, y: e.clientY, started: false, kind: null } as {
      x: number;
      y: number;
      timer?: ReturnType<typeof setTimeout>;
      started: boolean;
      kind: 'voice' | 'video' | null;
    };
    recGesture.current = g;
    g.timer = setTimeout(() => {
      if (recGesture.current !== g) return;
      const isVideo = recMode === 'cam';
      g.kind = isVideo ? 'video' : 'voice';
      g.started = true;
      inputRef.current?.blur();
      setTypingActive(false);
      if (isVideo) {
        void vdStart((take) => handleTakeVideoRef.current(take)).then((r) => {
          if (!r.ok) {
            if (recGesture.current === g) recGesture.current = null;
            notify(r.message ?? 'Не удалось начать запись');
          }
        });
        return;
      }
      void recStart((take) => handleTakeRef.current(take)).then((r) => {
        if (!r.ok) {
          if (recGesture.current === g) recGesture.current = null;
          notify(r.message ?? 'Не удалось начать запись');
        }
      });
    }, HOLD_TO_RECORD_MS);
  };

  const onRecMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = recGesture.current;
    // Фазу читаем из ref: после lock() рендер может не успеть до следующих событий.
    const phaseRef = g?.kind === 'video' ? vdPhaseRef : recPhaseRef;
    if (!g?.started || phaseRef.current !== 'holding') return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const armed = dx < CANCEL_DX;
    setCancelArmed((prev) => (prev === armed ? prev : armed));
    if (dy < LOCK_DY) {
      if (g.kind === 'video') vdLock();
      else recLock();
      // Синхронно: эффект-зеркало догонит позже, а pointerup может прийти раньше.
      phaseRef.current = 'locked';
      setCancelArmed(false);
      buzzLocal(15);
    }
  };

  const onRecUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = recGesture.current;
    recGesture.current = null;
    if (g?.timer) clearTimeout(g.timer);
    if (!g) return;
    if (!g.started) {
      // Быстрый тап — смена режима mic/cam.
      setRecMode((m) => (m === 'mic' ? 'cam' : 'mic'));
      buzzLocal(10);
      return;
    }
    const isVideo = g.kind === 'video';
    const phaseRef = isVideo ? vdPhaseRef : recPhaseRef;
    if (phaseRef.current === 'locked') return; // палец отпустили — пишем дальше
    if (e.clientX - g.x < CANCEL_DX) {
      if (isVideo) vdCancel();
      else recCancel();
    } else if (isVideo) {
      vdFinish(true);
    } else {
      recFinish(true);
    }
  };

  const onRecCancel = () => {
    const g = recGesture.current;
    recGesture.current = null;
    if (g?.timer) clearTimeout(g.timer);
    // Прерванный жест — не шлём сюрпризов; locked продолжает писаться.
    if (!g?.started) return;
    const isVideo = g.kind === 'video';
    const phaseRef = isVideo ? vdPhaseRef : recPhaseRef;
    if (phaseRef.current === 'locked') return;
    if (isVideo) vdCancel();
    else recCancel();
  };

  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const bootedRef = useRef(false);
  // Кнопка «Вниз»: видна, когда читают историю; бейдж — счётчик новых.
  const BOTTOM_PX = 120;
  const [showDown, setShowDown] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const atBottomRef = useRef(true);
  const prevLastRef = useRef<{ id: string; cmid: string } | null>(null);
  // Липкий низ: после программного скролла вниз каждый ререндер дожимаем
  // scrollTop до низа (картинки догружаются и сдвигают низ уже после скролла).
  // Снимается только жестом пользователя по ленте.
  const pinBottomRef = useRef(false);
  const smoothUntilRef = useRef(0);
  const goBottom = useCallback(() => {
    setNewCount(0);
    const el = listRef.current;
    if (el) {
      pinBottomRef.current = true;
      smoothUntilRef.current = Date.now() + 600;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);
  // Окно рендера: DOM держим маленьким (iPhone), полный объём — в IDB/state.
  const [renderCount, setRenderCount] = useState(120);
  const RENDER_STEP = 80;
  const RENDER_MAX = 500; // потолок DOM-узлов; история дальше — в IDB
  // Якорь скролла для бесшовной догрузки вверх.
  const anchorRef = useRef<{ h: number; top: number } | null>(null);

  // Обои дублируем на body: только так заливаются и safe-зоны
  // (верх под Dynamic Island и низ под home-индикатором), иначе там
  // виден голый фон темы. Цвет темы остаётся подложкой под картинкой.
  useEffect(() => {
    if (!wallpaperUrl) return;
    const b = document.body;
    const prevImage = b.style.backgroundImage;
    const prevSize = b.style.backgroundSize;
    const prevPosition = b.style.backgroundPosition;
    const prevRepeat = b.style.backgroundRepeat;
    b.style.backgroundImage = `url("${wallpaperUrl}")`;
    b.style.backgroundSize = 'cover';
    b.style.backgroundPosition = 'center';
    b.style.backgroundRepeat = 'no-repeat';
    return () => {
      b.style.backgroundImage = prevImage;
      b.style.backgroundSize = prevSize;
      b.style.backgroundPosition = prevPosition;
      b.style.backgroundRepeat = prevRepeat;
    };
  }, [wallpaperUrl]);

  // Замер плавающих баров → CSS-переменные для отступов ленты,
  // чтобы сообщения заходили под стекло, но не прятались под ним.
  useEffect(() => {
    const chat = chatRef.current;
    const top = topbarRef.current;
    const comp = composerRef.current;
    if (!chat || !top || !comp || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      chat.style.setProperty('--bar-top', `${Math.ceil(top.offsetHeight)}px`);
      chat.style.setProperty('--bar-bottom', `${Math.ceil(comp.offsetHeight)}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(top);
    ro.observe(comp);
    return () => ro.disconnect();
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
      // visualViewport сжимается и от тулбара Safari, а не только от клавиатуры.
      // Тулбар — системный хром (его не убрать), но бар поднимаем только когда
      // реально сфокусировано поле ввода, иначе тулбар ошибочно «поднимал» композер.
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const raw = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb-inset', `${typing ? Math.round(raw) : 0}px`);
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

  // Фото подгружаются сами при появлении в ленте.
  useEffect(() => {
    ensurePhotos(visible);
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
        void onLoadOlder().then((added) => {
          loadingOlderRef.current = false;
          if (added > 0) setRenderCount((c) => c + RENDER_STEP);
          else anchorRef.current = null;
        });
      },
      { root: listRef.current },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length, renderCount, onLoadOlder]);

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
    // Позиция чтения: внизу ли пользователь (кнопка «Вниз» + бейдж новых).
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const at = dist < BOTTOM_PX;
      atBottomRef.current = at;
      setShowDown((v) => (v === !at ? v : !at));
      if (at) setNewCount((c) => (c === 0 ? c : 0));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Автопрокрутка в стиле TG:
  // - первая загрузка — мгновенно вниз (прямой scrollTop, не scrollIntoView);
  // - новые внизу: мы внизу (или свои) — плавно вниз, иначе бейдж на кнопке;
  // - догрузка истории вверх / рост окна рендера (низ тот же) — не трогаем.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || visible.length === 0) return;
    const last = visible[visible.length - 1]!;
    const prev = prevLastRef.current;
    if (!bootedRef.current) {
      bootedRef.current = true;
      prevLastRef.current = { id: last.id, cmid: last.clientMessageId };
      pinBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (prev && prev.id === last.id) {
      // Низ тот же (история вверх / окно рендера), но если держим пин —
      // дожимаем (долетели картинки и сдвинули низ).
      if (pinBottomRef.current) el.scrollTop = el.scrollHeight;
      return;
    }
    prevLastRef.current = { id: last.id, cmid: last.clientMessageId };
    if (last.senderId === meUid || atBottomRef.current) {
      pinBottomRef.current = true;
      smoothUntilRef.current = Date.now() + 600;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      // Сколько новых после прошлого низа (матч по id и clientMessageId —
      // покрывает замену local-echo на серверное: тогда новых 0).
      let n = 1;
      if (prev) {
        for (let i = visible.length - 1; i >= 0; i -= 1) {
          const mm = visible[i]!;
          if (mm.id === prev.id || mm.clientMessageId === prev.cmid) {
            n = visible.length - 1 - i;
            break;
          }
        }
      }
      if (n > 0) setNewCount((c) => c + n);
    }
  }, [visible, meUid]);

  // Липкий низ: пока пин активен, каждый коммит дожимает низ без анимации
  // (картинки, typing, презенс сдвигают ленту без смены visible).
  // Плавный скролл не рвём: в его окне эффект молчит.
  useLayoutEffect(() => {
    if (!pinBottomRef.current) return;
    if (Date.now() < smoothUntilRef.current) return;
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 2) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // Жест по ленте снимает пин (дальше позицией владеет пользователь).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const unpin = () => {
      pinBottomRef.current = false;
    };
    el.addEventListener('pointerdown', unpin);
    el.addEventListener('wheel', unpin, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', unpin);
      el.removeEventListener('wheel', unpin);
    };
  }, []);

  // Театр кружка: большой просмотр с перемоткой (только готовое видео).
  // theaterMsg/theaterUrl считаем внизу у рендера (нужен visibleMap).
  const [videoTheaterId, setVideoTheaterId] = useState<string | null>(null);
  const openVideoTheater = useCallback(
    (m: ChatMessage) => {
      const st = photos[m.id];
      if (st?.status === 'ready') setVideoTheaterId(m.id);
    },
    [photos],
  );

  // Escape закрывает шторку, меню реакций, spark-панель и театр кружка.
  useEffect(() => {
    if (!sheetOpen && !menuFor && !sparkOpen && !videoTheaterId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSheetOpen(false);
        setMenuFor(null);
        setSparkOpen(false);
        setVideoTheaterId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen, menuFor, sparkOpen, videoTheaterId]);

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    const draft = replyDraft;
    setText('');
    setReplyDraft(null);
    fitInput();
    setTypingActive(false);
    setLocalSending(true);
    try {
      await onSubmitText(body, draft ? { replyTo: draft } : undefined);
    } finally {
      setLocalSending(false);
      // Клавиатура остаётся: фокус не отдаём (кнопка не забирает его — см. onPointerDown ниже).
      inputRef.current?.focus();
    }
  };

  // Автовысота поля: растёт до 4 строк (дальше — скролл внутри, см. CSS max-height).
  const fitInput = () => {
    const el = inputRef.current;
    if (!el) return;
    // eslint-disable-next-line react-hooks/immutability -- прямое измерение DOM-узла
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

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

  const standalone = isStandalone();
  const initial = (peerName.trim()[0] ?? '?').toUpperCase();

  // Карта сообщений для резолва цитат: по id и по clientMessageId
  // (покрывает pending-родителя: после эха id сменится, clientMessageId — нет).
  const visibleMap = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of visible) {
      map.set(m.id, m);
      map.set(`cm:${m.clientMessageId}`, m);
    }
    return map;
  }, [visible]);

  // Театр кружка: сообщение + готовый url (иначе null — не монтируем).
  const theaterMsg = videoTheaterId ? visibleMap.get(videoTheaterId) : undefined;
  const theaterState = theaterMsg ? photos[theaterMsg.id] : undefined;
  const theaterUrl =
    theaterState?.status === 'ready' ? (theaterState as { url: string }).url : null;

  // Сниппет черновика ответа (синхронно из окна; фото/вне окна — подпись).
  const draftParent = replyDraft
    ? (visibleMap.get(replyDraft.id) ??
      (replyDraft.clientMessageId
        ? visibleMap.get(`cm:${replyDraft.clientMessageId}`)
        : undefined))
    : undefined;
  const draftSnippet = !replyDraft
    ? ''
    : draftParent
      ? draftParent.kind === 'photo'
        ? '📷 Фото'
        : draftParent.kind === 'voice'
          ? '🎤 Голосовое'
          : draftParent.kind === 'video'
            ? '🎥 Кружок'
            : draftParent.decryptError
              ? 'Сообщение'
              : (draftParent.text ?? 'Сообщение')
      : 'Сообщение';

  // Прыжок к цитируемому: скролл + flash; нет в окне — тянем историю (кап 3 стр.).
  const jumpTo = useCallback(
    async (t: ReplyTarget) => {
      const list = listRef.current;
      if (!list) return;
      const find = () =>
        (list.querySelector(`[data-mid="${t.id}"]`) ??
          (t.clientMessageId
            ? list.querySelector(`[data-cmid="${t.clientMessageId}"]`)
            : null)) as HTMLElement | null;
      let el = find();
      for (let i = 0; i < 3 && !el; i += 1) {
        const added = await onLoadOlder().catch(() => 0);
        if (added <= 0) break;
        el = find();
      }
      if (!el) {
        notify('Сообщение уже выгружено из истории');
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1300);
    },
    [onLoadOlder, notify],
  );

  const handleReply = useCallback(
    (m: ChatMessage) => {
      if (m.pending) {
        notify('Сообщение ещё отправляется — ответь чуть позже');
        return;
      }
      setReplyDraft({ id: m.id, clientMessageId: m.clientMessageId, senderId: m.senderId });
      inputRef.current?.focus({ preventScroll: true });
    },
    [notify],
  );

  const copyText = useCallback(
    async (s: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(s);
        } else {
          const ta = document.createElement('textarea');
          ta.value = s;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        notify('Скопировано');
      } catch {
        notify('Не удалось скопировать');
      }
    },
    [notify],
  );

  // ---------- Spark: отправка, очередь, первый просмотр ----------

  // Мгновенная отправка spark-тапом из пикера (как стикер).
  const sendSpark = useCallback(
    async (emoji: string) => {
      if (busy) return;
      setSparkOpen(false);
      setTypingActive(false);
      try {
        await onSubmitText(emoji, { spark: true });
      } catch {
        // Ошибка уже показана через error/phоtoBusy-индикаторы выше.
      }
    },
    [busy, onSubmitText, setTypingActive],
  );

  // Реплей салюта тапом по spark-пузырю (локально, у кого угодно).
  const replaySpark = useCallback((m: ChatMessage) => {
    if (!m.text) return;
    setSparkQueue((q) => [...q, { key: sparkKeyRef.current++, emoji: m.text ?? '', effect: effectFor(m.text) }]);
  }, []);

  // Автосалют получателю: spark от пира, флага в IDB нет, вкладка на глазах.
  // Отправителю — никогда. Офлайн-приход догонит снапшотом и салютует при виде.
  useEffect(() => {
    if (disableSparkAuto) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    let alive = true;
    void (async () => {
      const fresh: { key: number; emoji: string; effect: SparkEffect }[] = [];
      for (const m of visible) {
        if (!m.spark || m.senderId === meUid || m.pending || !m.text) continue;
        if (sparkQueuedRef.current.has(m.id)) continue;
        let seen = false;
        try {
          seen = await sparkWasSeen(m.id);
        } catch {
          // IDB недоступен — считаем не виденным, сессионный дедуп через queuedRef.
        }
        if (!alive) return;
        if (seen) {
          sparkQueuedRef.current.add(m.id);
          continue;
        }
        try {
          await sparkMarkSeen(m.id);
        } catch {
          // IDB недоступен — салютуем разово за сессию через queuedRef.
        }
        sparkQueuedRef.current.add(m.id);
        fresh.push({ key: sparkKeyRef.current++, emoji: m.text ?? '', effect: effectFor(m.text) });
      }
      if (alive && fresh.length > 0) setSparkQueue((q) => [...q, ...fresh]);
    })();
    return () => {
      alive = false;
    };
  }, [visible, meUid, disableSparkAuto]);

  // Вернулся в приложение — рескан: могли прийти spark в фоне.
  // visible берём из ref (иначе замыкание протухнет).
  useEffect(() => {
    if (disableSparkAuto) return;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void (async () => {
        const fresh: { key: number; emoji: string; effect: SparkEffect }[] = [];
        for (const m of visibleRef.current) {
          if (!m.spark || m.senderId === meUid || m.pending || !m.text) continue;
          if (sparkQueuedRef.current.has(m.id)) continue;
          let seen = true;
          try {
            seen = await sparkWasSeen(m.id);
          } catch {
            // В фоне без IDB не гадаем — тишина лучше повтора.
          }
          if (!seen) {
            try {
              await sparkMarkSeen(m.id);
            } catch {
              // ignore
            }
            sparkQueuedRef.current.add(m.id);
            fresh.push({ key: sparkKeyRef.current++, emoji: m.text ?? '', effect: effectFor(m.text) });
          } else {
            sparkQueuedRef.current.add(m.id);
          }
        }
        if (fresh.length > 0) setSparkQueue((q) => [...q, ...fresh]);
      })();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [disableSparkAuto, meUid]);

  // Меню закрывается скроллом ленты и кликом мимо поповера (без бэкдропа,
  // чтобы не блокировать ленту; клики внутри поповера — stopPropagation).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      if (menuForRef.current) setMenuFor(null);
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest('.react-popover')) setMenuFor(null);
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [menuFor]);

  // Кастомные цвета пузырей поверх темы (null = цвет темы).
  const themeVars = {
    ...(settings.bubbleColorMine ? { '--bubble-mine': settings.bubbleColorMine } : null),
    ...(settings.bubbleColorTheirs ? { '--bubble-theirs': settings.bubbleColorTheirs } : null),
    ...(settings.bubbleColorMine ? { '--glass-mine': settings.bubbleColorMine } : null),
    ...(settings.bubbleColorTheirs ? { '--glass-theirs': settings.bubbleColorTheirs } : null),
  } as CSSProperties;

  return (
    <div className="chat" ref={chatRef} style={themeVars}>
      {wallpaperUrl && (
        <div className="wallpaper-layer" style={{ backgroundImage: `url("${wallpaperUrl}")` }} />
      )}
      <header className="topbar" ref={topbarRef}>
        <div className="avatar" style={avatarUrl ? undefined : { background: settings.avatarColor }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt={peerName} />
          ) : (
            <span style={{ color: '#fff' }}>{initial}</span>
          )}
        </div>
        <div className="top-title">
          <strong>{peerName}</strong>
          <span className="top-sub">
            <span className={`dot${peerOnline ? '' : ' off'}`} />
            <Lock size={11} />
            {peerStatusText}
          </span>
        </div>
        <div className="top-actions">
          <button
            className="icon-btn"
            onClick={() => setSheetOpen(true)}
            title="Настройки"
            aria-label="Настройки"
          >
            <EllipsisVertical size={19} />
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
      {shownError && <div className="error chat-error">{shownError}</div>}

      <div className="list" ref={listRef}>
        {visible.length > 0 && <div ref={topSentinelRef} aria-hidden />}
        {items.slice(-renderCount).map(({ m, day, showDay, grouped }) => {
          const mine = m.senderId === meUid;
          const glass = mine ? settings.bubbleGlassMine : settings.bubbleGlassTheirs;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="day-divider">{day}</div>}
              <MessageBubble
                m={m}
                mine={mine}
                grouped={grouped}
                glass={glass}
                meUid={meUid}
                peerName={peerName}
                roomKey={roomKey}
                photos={photos}
                menuOpen={menuFor?.id === m.id}
                menuFlip={menuFor?.id === m.id ? menuFor.flip : false}
                onOpenMenu={(flip) => setMenuFor({ id: m.id, flip })}
                onCloseMenu={() => setMenuFor((cur) => (cur?.id === m.id ? null : cur))}
                onReply={handleReply}
                onJump={(t) => void jumpTo(t)}
                onSparkReplay={replaySpark}
                onExpandVideo={openVideoTheater}
                onErrorTap={(msg) => {
                  const draft = onRestoreDraft(msg.clientMessageId);
                  if (draft) setText(draft);
                }}
                onRetryPhoto={onRetryPhoto}
                onOpenViewer={onOpenViewer}
                onCopyText={(s) => void copyText(s)}
                notify={notify}
                visibleMap={visibleMap}
                seedReactions={seedReactions?.[m.id]}
                videoShape={settings.videoShape}
                videoRadius={settings.videoRadius}
                reactionsLocalOnly={reactionsLocalOnly}
              />
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
      </div>

      {showDown && (
        <button className="to-bottom" onClick={goBottom} aria-label="Вниз к новым сообщениям">
          <ArrowDown size={20} />
          {newCount > 0 && (
            <span className="down-badge">{newCount > 99 ? '99+' : newCount}</span>
          )}
        </button>
      )}

      {vdRecording && (
        <div className="vrec-stage" aria-live="polite" aria-label="Идёт запись кружка">
          <div
            className="vrec-big"
            style={{
              borderRadius:
                settings.videoShape === 'circle' ? '50%' : `${settings.videoRadius * 2}px`,
            }}
          >
            <video
              ref={vdPreviewRef}
              muted
              playsInline
              autoPlay
              style={vdFacing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
            />
          </div>
          <div className="vrec-timer">{formatVoiceTime(vdElapsed)}</div>
          <div className="vrec-progress" aria-hidden>
            <i style={{ width: `${Math.min(100, (vdElapsed / MAX_VIDEO_MS) * 100)}%` }} />
          </div>
        </div>
      )}

      <form className="composer" ref={composerRef} onSubmit={(e) => void onSubmit(e)}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              const draft = replyDraft;
              setReplyDraft(null);
              onPickFile(f, draft ? { replyTo: draft } : undefined);
            }
          }}
        />
        {replyDraft && (
          <div className="reply-draft">
            <span className="reply-draft-bar" />
            <span className="reply-draft-text">
              <strong>{replyDraft.senderId === meUid ? 'Вы' : peerName}</strong>
              <span>{draftSnippet}</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setReplyDraft(null)}
              title="Отменить ответ"
              aria-label="Отменить ответ"
            >
              <X size={15} />
            </button>
          </div>
        )}
        {!recording && (
          <button
            type="button"
            className="icon-btn"
            disabled={photoBusy}
            onClick={() => fileRef.current?.click()}
            onPointerDown={(e) => e.preventDefault()}
            title="Отправить фото"
            aria-label="Отправить фото"
          >
            {photoBusy ? <Loader2 size={20} className="spin" /> : <Plus size={20} />}
          </button>
        )}
        {!recording && (
          <button
            type="button"
            className={`icon-btn${sparkOpen ? ' active' : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setSparkOpen((v) => !v);
              setMenuFor(null);
            }}
            title="Spark — салют"
            aria-label="Spark — салют"
          >
            <Heart size={20} />
          </button>
        )}
        {recording ? (
          vdRecording ? (
            <div className="rec-ui">
              <button
                type="button"
                className={`rec-trash${cancelArmed ? ' armed' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => vdCancel()}
                title="Удалить запись"
                aria-label="Удалить запись"
              >
                <Trash2 size={19} />
              </button>
              <span className="rec-dot" aria-hidden />
              <span className="rec-time">{formatVoiceTime(vdElapsed)}</span>
              <button
                type="button"
                className="icon-btn"
                onPointerDown={(e) => e.preventDefault()}
                onClick={flipVideo}
                title="Перевернуть камеру"
                aria-label="Перевернуть камеру"
              >
                <SwitchCamera size={19} />
              </button>
              {vdPhase === 'locked' ? (
                <button
                  type="button"
                  className="send-btn"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => vdFinish(true)}
                  title="Остановить и отправить"
                  aria-label="Остановить и отправить"
                >
                  <Square size={15} />
                </button>
              ) : (
                <span className="rec-lock-hint" aria-hidden>
                  <Lock size={12} />
                  <ChevronUp size={15} />
                </span>
              )}
            </div>
          ) : (
            <div className="rec-ui">
            <button
              type="button"
              className={`rec-trash${cancelArmed ? ' armed' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => recCancel()}
              title="Удалить запись"
              aria-label="Удалить запись"
            >
              <Trash2 size={19} />
            </button>
            <span className="rec-dot" aria-hidden />
            <span className="rec-time">{formatVoiceTime(recElapsed)}</span>
            <div className="rec-bars" ref={recBarsRef} aria-hidden>
              {Array.from({ length: LIVE_BARS }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
            {recPhase === 'locked' ? (
              <button
                type="button"
                className="send-btn"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => recFinish(true)}
                title="Остановить и отправить"
                aria-label="Остановить и отправить"
              >
                <Square size={15} />
              </button>
            ) : (
              <span className="rec-lock-hint" aria-hidden>
                <Lock size={12} />
                <ChevronUp size={15} />
              </span>
            )}
            </div>
          )
        ) : sparkOpen ? (
          <div className="spark-panel" role="dialog" aria-label="Spark — выбери салют">
            {SPARK_SET.map((s) => (
              <button
                key={s.emoji}
                type="button"
                className="spark-item"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => void sendSpark(s.emoji)}
                aria-label={`Отправить ${s.emoji}`}
              >
                {s.emoji}
              </button>
            ))}
            <button
              type="button"
              className="icon-btn"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setSparkOpen(false)}
              title="Закрыть"
              aria-label="Закрыть"
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <textarea
            ref={inputRef}
            className="composer-input"
            value={text}
            rows={1}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              setTypingActive(v.trim().length > 0);
              fitInput();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSubmit();
              }
            }}
            placeholder="Сообщение"
            maxLength={4000}
            enterKeyHint="send"
          />
        )}
        {!recording && text.trim() ? (
          <button
            type="submit"
            className="send-btn"
            disabled={busy}
            onPointerDown={(e) => e.preventDefault()}
            aria-label="Отправить"
          >
            {busy ? <Loader2 size={18} className="spin" /> : <ArrowUp size={18} />}
          </button>
        ) : (
          <button
            type="button"
            className={`rec-btn${recording ? ' recording' : ''}`}
            disabled={photoBusy}
            onPointerDown={onRecDown}
            onPointerMove={onRecMove}
            onPointerUp={onRecUp}
            onPointerCancel={onRecCancel}
            onContextMenu={(e) => e.preventDefault()}
            title={recMode === 'mic' ? 'Голосовое (удерживай)' : 'Видео (скоро)'}
            aria-label={recMode === 'mic' ? 'Записать голосовое' : 'Записать видео'}
          >
            {recMode === 'mic' ? <Mic size={20} /> : <Video size={20} />}
          </button>
        )}
      </form>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {sparkHead && (
        <SparkOverlay
          key={sparkHead.key}
          emoji={sparkHead.emoji}
          effect={sparkHead.effect}
          seed={sparkHead.key}
          onDone={() => setSparkQueue((q) => q.slice(1))}
        />
      )}

      {viewer && (
        <div className="modal viewer" onClick={onCloseViewer}>
          <img src={viewer.url} alt="фото" onClick={(e) => e.stopPropagation()} />
          <button className="viewer-close" onClick={onCloseViewer}>
            <X size={16} /> Закрыть
          </button>
        </div>
      )}

      {theaterMsg && theaterUrl && (
        <VideoTheater
          key={theaterMsg.id}
          m={theaterMsg}
          url={theaterUrl}
          shape={settings.videoShape}
          radius={settings.videoRadius}
          onClose={() => setVideoTheaterId(null)}
        />
      )}

      <SettingsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        settings={settings}
        update={updateSettings}
        resetAppearance={resetAppearance}
        avatarUrl={avatarUrl}
        onPickAvatar={onPickAvatar}
        onClearAvatar={onClearAvatar}
        wallpaperUrl={wallpaperUrl}
        onPickWallpaper={onPickWallpaper}
        onClearWallpaper={onClearWallpaper}
        pushOn={pushOn}
        pushBusy={pushBusy}
        onTogglePush={() => void onTogglePush()}
        pushStatus={pushStatus}
        email={userEmail}
        onLogout={onLogout}
        onShowKey={onShowKey}
        onWipeDevice={onWipeDevice}
        debugLines={debugLines}
      />
    </div>
  );
}
