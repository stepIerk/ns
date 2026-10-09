import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { useChat } from '../hooks/useChat';
import { useMedia } from '../hooks/useMedia';
import { APP_VERSION } from '../lib/version';
import { ENABLE_MEDIA } from '../lib/flags';
import { disablePush, enablePush, hasPushSubscription, registerSW } from '../lib/push';

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

export default function Chat({ user, roomKey, onShowKey, onLogout }: Props) {
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
  } = useChat(user.uid, roomKey);

  const media = useMedia(user.uid, roomKey, notifyMessage);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [debugOpen, setDebugOpen] = useState(
    () => typeof window !== 'undefined' && window.location.search.includes('debug=1'),
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // SW регистрируем заранее (не в жесте), чтобы в жесте остались только
  // permission + subscribe — это требование iOS PWA.
  useEffect(() => {
    registerSW().catch(() => {});
    hasPushSubscription().then(setPushOn).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visible.length]);

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setText('');
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

  return (
    <div className="chat">
      <header className="topbar">
        <div>
          <strong>main</strong>
          <span className="muted"> · {user.email}</span>
          <span className="muted small"> · v{APP_VERSION}</span>
        </div>
        <div className="row">
          <button onClick={onShowKey}>QR ключа</button>
          <button onClick={() => void onTogglePush()} disabled={pushBusy}>
            {pushOn ? 'Push: вкл' : 'Push: выкл'}
          </button>
          <button onClick={() => setDebugOpen((v) => !v)}>⚙</button>
          <button onClick={onLogout}>Выйти</button>
        </div>
      </header>

      {offline && <div className="banner">Офлайн / переподключение…</div>}
      {!standalone && !pushOn && (
        <div className="banner">
          iOS: для уведомлений откройте сайт с иконки «На экране Домой» (Add to Home Screen), затем
          включите Push кнопкой выше.
        </div>
      )}
      {shownError && <div className="error">{shownError}</div>}
      {debugOpen && (
        <div className="card" style={{ margin: 8 }}>
          <div className="small">
            online={String(online)} fromCache={String(fromCache)} snapshots={snapCount} msgs=
            {visible.length}
          </div>
          <div className="small">api={apiBase}</div>
          {pushStatus && <div className="small">{pushStatus}</div>}
          {snapError && <div className="small">snap err: {snapError}</div>}
          <div className="small muted">
            iOS: сообщения в фоне приходят только пушем. Если snap растёт, а пуша нет — смотри
            строку push выше (там же видно skipped/FAIL).
          </div>
        </div>
      )}

      <div className="list">
        {visible.map((m) => {
          const mine = m.senderId === user.uid;
          return (
            <div key={m.id} className={mine ? 'msg mine' : 'msg theirs'}>
              {m.kind === 'text' ? (
                <div className="bubble">
                  {m.decryptError ? <i>Не удалось расшифровать</i> : m.text}
                  <div className="meta">
                    {new Date(m.createdAtMs).toLocaleTimeString()} ·{' '}
                    {m.pending ? (m.status === 'error' ? 'ошибка' : 'отправка…') : 'отправлено'}
                    {m.pending && m.status === 'error' && (
                      <button
                        onClick={() => {
                          const draft = retryToDraft(m.clientMessageId);
                          if (draft) setText(draft);
                        }}
                      >
                        ↻ в поле ввода
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="bubble">
                  <button
                    disabled={!ENABLE_MEDIA || media.viewerLoading === m.id}
                    onClick={() => ENABLE_MEDIA && void media.openPhoto(m)}
                  >
                    {media.viewerLoading === m.id
                      ? 'Загрузка…'
                      : `📷 Фото (${Math.round((m.size ?? 0) / 1024)} КБ, шифр) — открыть`}
                  </button>
                  <div className="meta">
                    {new Date(m.createdAtMs).toLocaleTimeString()} · отправлено
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={(e) => void onSubmit(e)}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Сообщение (шифруется)"
          maxLength={4000}
        />
        <button type="submit" disabled={sending || !text.trim()}>
          {sending ? '…' : '➤'}
        </button>
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
            <button type="button" disabled={media.photoBusy} onClick={() => fileRef.current?.click()}>
              {media.photoBusy ? '…' : '📷'}
            </button>
          </>
        )}
      </form>

      {ENABLE_MEDIA && media.viewer && (
        <div className="modal" onClick={() => media.closeViewer()}>
          <img
            src={media.viewer.url}
            alt="расшифрованное фото"
            onClick={(e) => e.stopPropagation()}
          />
          <button onClick={() => media.closeViewer()}>Закрыть</button>
        </div>
      )}
    </div>
  );
}
