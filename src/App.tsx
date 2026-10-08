import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AuthProvider, useAuth } from './lib/auth';
import { isFirebaseConfigured } from './lib/firebase';
import { exportRoomKeyToString } from './lib/crypto';
import { clearRoomKey, loadRoomKey } from './lib/keystore';
import { disablePush } from './lib/push';
import Login from './components/Login';
import PairingGate from './components/PairingGate';
import Chat from './components/Chat';

function Shell() {
  const { user, loading, logout } = useAuth();
  const [roomKey, setRoomKey] = useState<CryptoKey | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [keyString, setKeyString] = useState('');

  const userUid = user?.uid ?? null;
  useEffect(() => {
    if (!userUid) return;
    let alive = true;
    loadRoomKey().then((k) => {
      if (alive && k) setRoomKey((prev) => prev ?? k);
    });
    return () => {
      alive = false;
    };
  }, [userUid]);

  const handleLogout = () => {
    setRoomKey(null);
    setShowKey(false);
    // best-effort: убрать push-подписку этого браузера, чтобы тестовый комп не получал пуши
    if (userUid) void disablePush(userUid).catch(() => {});
    void logout();
  };

  // Полный сброс тестового устройства: ключ + сессия. Firestore-историю не трогает.
  const handleWipeDevice = async () => {
    if (!window.confirm('Удалить room key с ЭТОГО устройства и выйти? История в Firestore останется.')) return;
    try {
      if (userUid) await disablePush(userUid).catch(() => {});
      await clearRoomKey();
    } finally {
      setRoomKey(null);
      setShowKey(false);
      await logout().catch(() => {});
    }
  };

  useEffect(() => {
    if (showKey && roomKey) {
      exportRoomKeyToString(roomKey).then(setKeyString).catch(() => {});
    }
  }, [showKey, roomKey]);

  if (!isFirebaseConfigured) {
    return (
      <div className="screen">
        <div className="card">
          <h2>Нет конфигурации Firebase</h2>
          <p>Заполните VITE_FIREBASE_* в .env (см. .env.example), затем перезапустите.</p>
        </div>
      </div>
    );
  }
  if (loading) return <div className="screen"><p>Загрузка сессии…</p></div>;
  if (!user) return <Login />;
  if (!roomKey) return <PairingGate onReady={setRoomKey} />;

  return (
    <>
      <Chat
        user={user}
        roomKey={roomKey}
        onLogout={handleLogout}
        onShowKey={() => setShowKey(true)}
      />
      {showKey && (
        <div className="modal" onClick={() => setShowKey(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h3>Room key для второго устройства</h3>
            {keyString && <QRCodeSVG value={keyString} size={220} />}
            <textarea readOnly value={keyString} rows={3} style={{ width: '100%' }} />
            <div className="row">
              <button onClick={() => setShowKey(false)}>Закрыть</button>
              <button onClick={() => void handleWipeDevice()}>Удалить ключ с этого устройства</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
