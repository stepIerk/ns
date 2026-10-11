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
  ArrowUp,
  EllipsisVertical,
  Loader2,
  Lock,
  Plus,
  WifiOff,
  X,
} from 'lucide-react';
import type { PhotoState } from '../hooks/useMedia';
import type { ReactionMap } from '../hooks/useReactions';
import type { LocalSettings } from '../lib/settings';
import MessageBubble from './MessageBubble';
import SettingsSheet from './SettingsSheet';
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
  onSubmitText: (text: string, opts?: { replyTo?: ReplyTarget }) => Promise<void>;
  onPickFile: (f: File, opts?: { replyTo?: ReplyTarget }) => void;
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
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const bootedRef = useRef(false);
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

  // Escape закрывает шторку и меню реакций.
  useEffect(() => {
    if (!sheetOpen && !menuFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSheetOpen(false);
        setMenuFor(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen, menuFor]);

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
        <div ref={bottomRef} />
      </div>

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
        <button
          type="submit"
          className="send-btn"
          disabled={busy || !text.trim()}
          onPointerDown={(e) => e.preventDefault()}
          aria-label="Отправить"
        >
          {busy ? <Loader2 size={18} className="spin" /> : <ArrowUp size={18} />}
        </button>
      </form>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {viewer && (
        <div className="modal viewer" onClick={onCloseViewer}>
          <img src={viewer.url} alt="фото" onClick={(e) => e.stopPropagation()} />
          <button className="viewer-close" onClick={onCloseViewer}>
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
