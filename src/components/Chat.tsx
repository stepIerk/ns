import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { decryptBytes, decryptText, encryptBytes, encryptText } from '../lib/crypto';
import { authedPost } from '../lib/api';
import { disablePush, enablePush, hasPushSubscription, registerSW } from '../lib/push';
import type { ChatMessage, MessageDoc } from '../types';

interface Props {
  user: User;
  roomKey: CryptoKey;
  onShowKey: () => void;
  onLogout: () => void;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function tsOf(d: MessageDoc): number {
  if (typeof d.clientTs === 'number') return d.clientTs;
  return Date.now();
}

function statusOf(d: MessageDoc): ChatMessage['status'] {
  if (d.readAt) return 'read';
  if (d.deliveredAt) return 'delivered';
  return 'sent';
}

export default function Chat({ user, roomKey, onShowKey, onLogout }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [conn, setConn] = useState<{ online: boolean; fromCache: boolean }>({ online: navigator.onLine, fromCache: false });
  const [err, setErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ url: string; mime: string } | null>(null);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const keyRef = useRef(roomKey);
  keyRef.current = roomKey;
  const seenPushRef = useRef<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // online/offline
  useEffect(() => {
    const f = () => setConn((c) => ({ ...c, online: navigator.onLine }));
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => {
      window.removeEventListener('online', f);
      window.removeEventListener('offline', f);
    };
  }, []);

  useEffect(() => {
    registerSW().catch(() => {});
    hasPushSubscription().then(setPushOn).catch(() => {});
  }, []);

  // realtime
  useEffect(() => {
    const fb = getFirebase();
    if (!fb) return;
    const q = query(
      collection(fb.db, 'rooms', 'main', 'messages'),
      orderBy('clientTs', 'asc'),
      limitToLast(100),
    );
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        setConn((c) => ({ ...c, fromCache: snap.metadata.fromCache }));
        const key = keyRef.current;
        const docs = snap.docs;
        void (async () => {
          const out: ChatMessage[] = [];
          for (const d of docs) {
            const v = d.data() as MessageDoc;
            const base: ChatMessage = {
              id: d.id,
              clientMessageId: v.clientMessageId ?? d.id,
              senderId: v.senderId ?? '?',
              createdAtMs: tsOf(v),
              kind: v.kind ?? 'text',
              mediaId: v.mediaId,
              objectKey: v.objectKey,
              mimeType: v.mimeType,
              size: v.size,
              iv: v.iv,
              status: statusOf(v),
            };
            if (base.kind === 'text') {
              try {
                if (v.ciphertext && v.iv) base.text = await decryptText(key, v.iv, v.ciphertext);
                else base.decryptError = true;
              } catch {
                base.decryptError = true;
              }
            }
            out.push(base);
          }
          setMessages(out);
          // delivered/read для входящих
          for (const d of docs) {
            const v = d.data() as MessageDoc;
            if (v.senderId === user.uid) continue;
            try {
              if (!v.deliveredAt) await updateDoc(d.ref, { deliveredAt: serverTimestamp() });
              else if (!v.readAt) await updateDoc(d.ref, { readAt: serverTimestamp() });
            } catch {
              // rules/offline — игнорируем, попробуем позже
            }
          }
        })();
      },
      (e) => setErr(`Realtime ошибка: ${e.message}`),
    );
    return unsub;
  }, [user.uid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending.length]);

  const firePush = useCallback(async (messageId: string) => {
    if (seenPushRef.current.has(messageId)) return;
    seenPushRef.current.add(messageId);
    try {
      await authedPost('/api/push', { messageId });
    } catch (e) {
      console.warn('[push] trigger failed', e);
    }
  }, []);

  const sendText = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setErr(null);
    const clientMessageId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: `local-${clientMessageId}`,
      clientMessageId,
      senderId: user.uid,
      createdAtMs: Date.now(),
      kind: 'text',
      text: body,
      status: 'sending',
      pending: true,
    };
    setPending((p) => [...p, optimistic]);
    setText('');
    setSending(true);
    try {
      const { ivB64, ctB64 } = await encryptText(keyRef.current, body);
      const fb = getFirebase();
      if (!fb) throw new Error('Firebase не настроен');
      // защита от дубля: не отправляем дважды один clientMessageId
      const ref = await addDoc(collection(fb.db, 'rooms', 'main', 'messages'), {
        clientMessageId,
        senderId: user.uid,
        createdAt: serverTimestamp(),
        clientTs: Date.now(),
        kind: 'text',
        ciphertext: ctB64,
        iv: ivB64,
      } satisfies MessageDoc);
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      void firePush(ref.id);
    } catch (e2) {
      setPending((p) =>
        p.map((m) =>
          m.clientMessageId === clientMessageId
            ? { ...m, status: 'error', errorText: e2 instanceof Error ? e2.message : 'Ошибка' }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const retryPending = (clientMessageId: string) => {
    const item = pending.find((m) => m.clientMessageId === clientMessageId);
    if (!item?.text) return;
    setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
    setText(item.text);
  };

  const sendPhoto = async (file: File) => {
    setErr(null);
    if (!file.type.startsWith('image/')) {
      setErr('Пока поддерживаются только изображения');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setErr('Фото больше 10 МБ');
      return;
    }
    setPhotoBusy(true);
    const clientMessageId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    try {
      const plain = await file.arrayBuffer();
      const { ivB64, cipher } = await encryptBytes(keyRef.current, plain);
      const up = await authedPost<{ putUrl: string; objectKey: string }>('/api/media/upload-url', {
        mediaId,
        mimeType: file.type,
        size: cipher.byteLength,
      });
      const put = await fetch(up.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: cipher,
      });
      if (!put.ok) throw new Error(`B2 upload failed: ${put.status}`);
      const fb = getFirebase();
      if (!fb) throw new Error('Firebase не настроен');
      await setDoc(doc(fb.db, 'media', mediaId), {
        messageId: clientMessageId,
        objectKey: up.objectKey,
        size: cipher.byteLength,
        mimeType: file.type,
        iv: ivB64,
        senderId: user.uid,
        createdAt: serverTimestamp(),
      });
      const ref = await addDoc(collection(fb.db, 'rooms', 'main', 'messages'), {
        clientMessageId,
        senderId: user.uid,
        createdAt: serverTimestamp(),
        clientTs: Date.now(),
        kind: 'photo',
        mediaId,
        objectKey: up.objectKey,
        mimeType: file.type,
        size: cipher.byteLength,
        iv: ivB64,
      } satisfies MessageDoc);
      void firePush(ref.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось отправить фото');
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openPhoto = async (m: ChatMessage) => {
    if (!m.objectKey || !m.iv) return;
    setViewerLoading(m.id);
    setErr(null);
    try {
      const { getUrl } = await authedPost<{ getUrl: string }>('/api/media/download-url', {
        objectKey: m.objectKey,
      });
      const res = await fetch(getUrl);
      if (!res.ok) throw new Error(`B2 download failed: ${res.status}`);
      const cipher = await res.arrayBuffer();
      const plain = await decryptBytes(keyRef.current, m.iv, cipher);
      const blob = new Blob([plain], { type: m.mimeType ?? 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      setViewer((v) => {
        if (v) URL.revokeObjectURL(v.url);
        return { url, mime: m.mimeType ?? 'image/jpeg' };
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось открыть фото');
    } finally {
      setViewerLoading(null);
    }
  };

  const togglePush = async () => {
    setErr(null);
    try {
      if (pushOn) {
        await disablePush(user.uid);
        setPushOn(false);
      } else {
        await enablePush(user.uid);
        setPushOn(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Push ошибка');
    }
  };

  const visible = [...messages, ...pending].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const offline = !conn.online || conn.fromCache;

  return (
    <div className="chat">
      <header className="topbar">
        <div>
          <strong>main</strong>
          <span className="muted"> · {user.email}</span>
        </div>
        <div className="row">
          <button onClick={onShowKey}>QR ключа</button>
          <button onClick={togglePush}>{pushOn ? 'Push: вкл' : 'Push: выкл'}</button>
          <button onClick={onLogout}>Выйти</button>
        </div>
      </header>

      {offline && <div className="banner">Офлайн / переподключение… сообщения отправятся при связи</div>}
      {err && <div className="error">{err}</div>}

      <div className="list">
        {visible.map((m) => {
          const mine = m.senderId === user.uid;
          return (
            <div key={m.id} className={mine ? 'msg mine' : 'msg theirs'}>
              {m.kind === 'text' ? (
                <div className="bubble">
                  {m.decryptError ? <i>Не удалось расшифровать</i> : m.text}
                  <div className="meta">
                    {new Date(m.createdAtMs).toLocaleTimeString()} · {m.status}
                    {m.pending && m.status === 'error' && (
                      <button onClick={() => retryPending(m.clientMessageId)}>↻ в поле ввода</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="bubble">
                  <button disabled={viewerLoading === m.id} onClick={() => openPhoto(m)}>
                    {viewerLoading === m.id ? 'Загрузка…' : `📷 Фото (${Math.round((m.size ?? 0) / 1024)} КБ, шифр) — открыть`}
                  </button>
                  <div className="meta">
                    {new Date(m.createdAtMs).toLocaleTimeString()} · {m.status}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={sendText}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Сообщение (шифруется)"
          maxLength={4000}
        />
        <button type="submit" disabled={sending || !text.trim()}>
          {sending ? '…' : '➤'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void sendPhoto(f);
          }}
        />
        <button type="button" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
          {photoBusy ? '…' : '📷'}
        </button>
      </form>

      {viewer && (
        <div className="modal" onClick={() => { URL.revokeObjectURL(viewer.url); setViewer(null); }}>
          <img src={viewer.url} alt="расшифрованное фото" onClick={(e) => e.stopPropagation()} />
          <button onClick={() => { URL.revokeObjectURL(viewer.url); setViewer(null); }}>Закрыть</button>
        </div>
      )}
    </div>
  );
}
