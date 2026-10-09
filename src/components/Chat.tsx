import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { useChat } from '../hooks/useChat';
import { APP_VERSION } from '../lib/version';
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
    sendText,
    retryToDraft,
  } = useChat(user.uid, roomKey);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [debugOpen, setDebugOpen] = useState(
    () => typeof window !== 'undefined' && window.location.search.includes('debug=1'),
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
      {error && <div className="error">{error}</div>}
      {debugOpen && (
        <div className="card" style={{ margin: 8 }}>
          <div className="small">
            online={String(online)} fromCache={String(fromCache)} snapshots={snapCount} msgs=
            {visible.length}
          </div>
          {snapError && <div className="small">snap err: {snapError}</div>}
        </div>
      )}

      <div className="list">
        {visible.map((m) => {
          const mine = m.senderId === user.uid;
          return (
            <div key={m.id} className={mine ? 'msg mine' : 'msg theirs'}>
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
      </form>
    </div>
  );
}
