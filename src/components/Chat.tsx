import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { useChat } from '../hooks/useChat';
import { useMedia } from '../hooks/useMedia';
import { isOnline, isTyping, lastSeenText, usePresence } from '../hooks/usePresence';
import { assetDel, assetGet, assetPut, dbStats, storageEstimate } from '../lib/db';
import { prepareImage } from '../lib/image';
import type { LocalSettings } from '../lib/settings';
import { disablePush, enablePush, hasPushSubscription, registerSW } from '../lib/push';
import ChatView from './ChatView';

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

/** Боевой чат: хуки + ассеты + диагностика, рисует презентационный ChatView. */
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

  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<string | null>(null);
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // SW регистрируем заранее (не в жесте), чтобы в жесте остались только
  // permission + subscribe — это требование iOS PWA.
  useEffect(() => {
    registerSW().catch(() => {});
    hasPushSubscription().then(setPushOn).catch(() => {});
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

  const offline = !online || fromCache;

  const peerOnline = isOnline(presence) && !offline;
  const peerTyping = isTyping(presence) && !offline;
  const peerStatusText = offline
    ? 'переподключение…'
    : peerTyping
      ? 'печатает…'
      : peerOnline
        ? 'в сети'
        : (lastSeenText(presence) ?? 'сквозное шифрование');

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

  return (
    <ChatView
      meUid={user.uid}
      userEmail={user.email ?? ''}
      messages={visible}
      photos={media.photos}
      peerName={settings.peerName}
      peerOnline={peerOnline}
      peerTyping={peerTyping}
      peerStatusText={peerStatusText}
      offline={offline}
      error={error ?? media.mediaError}
      sending={false}
      photoBusy={media.photoBusy}
      viewer={media.viewer}
      settings={settings}
      updateSettings={updateSettings}
      resetAppearance={resetAppearance}
      avatarUrl={avatarUrl}
      wallpaperUrl={wallpaperUrl}
      onPickAvatar={pickAvatar}
      onClearAvatar={clearAvatar}
      onPickWallpaper={pickWallpaper}
      onClearWallpaper={clearWallpaper}
      onSubmitText={async (body) => {
        await sendText(body);
      }}
      onPickFile={(f) => {
        void media.sendPhoto(f);
      }}
      onRetryPhoto={(m) => media.retryPhoto(m)}
      onOpenViewer={(id) => media.openViewer(id)}
      onCloseViewer={() => media.closeViewer()}
      onRestoreDraft={(clientMessageId) => retryToDraft(clientMessageId)}
      setTypingActive={(active) => setTyping(active)}
      ensurePhotos={(msgs) => media.ensurePhotos(msgs)}
      markSeen={(ts) => markSeen(ts)}
      onLoadOlder={() => loadOlder()}
      pushOn={pushOn}
      pushBusy={pushBusy}
      onTogglePush={() => void onTogglePush()}
      pushStatus={pushStatus}
      onShowKey={onShowKey}
      onLogout={onLogout}
      onWipeDevice={onWipeDevice}
      debugLines={debugLines}
    />
  );
}
