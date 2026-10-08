import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AuthProvider, useAuth } from './lib/auth';
import { isFirebaseConfigured } from './lib/firebase';
import { exportRoomKeyToString } from './lib/crypto';
import { loadRoomKey } from './lib/keystore';
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
    void logout();
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
            <button onClick={() => setShowKey(false)}>Закрыть</button>
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
