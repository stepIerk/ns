import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  exportRoomKeyToString,
  generateRoomKey,
  importRoomKeyFromString,
} from '../lib/crypto';
import { loadRoomKey, saveRoomKey, saveRoomKeyString } from '../lib/keystore';

interface Props {
  onReady: (key: CryptoKey) => void;
}

/**
 * Gate: без room key в IndexedDB дальше не пускаем.
 * Первое устройство — «Создать», второе — «Сканировать/ввести».
 */
export default function PairingGate({ onReady }: Props) {
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'choose' | 'show' | 'enter' | 'scan'>('choose');
  const [qrValue, setQrValue] = useState<string>('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanStopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadRoomKey()
      .then((k) => {
        if (k) onReady(k);
        else setChecking(false);
      })
      .catch(() => setChecking(false));
    return () => scanStopRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      const key = await generateRoomKey();
      await saveRoomKey(key);
      const raw = await exportRoomKeyToString(key);
      setQrValue(raw);
      setMode('show');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать ключ');
    } finally {
      setBusy(false);
    }
  };

  const commitCode = async (rawInput: string) => {
    setErr(null);
    setBusy(true);
    try {
      const key = await saveRoomKeyString(rawInput).then(() => importRoomKeyFromString(rawInput));
      onReady(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Неверный код ключа');
    } finally {
      setBusy(false);
    }
  };

  const startScan = async () => {
    setErr(null);
    setMode('scan');
    try {
      if (!('BarcodeDetector' in window)) {
        setErr('Сканер QR не поддерживается — введите код вручную');
        setMode('enter');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      // @ts-expect-error — BarcodeDetector может отсутствовать в типах
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      let stopped = false;
      scanStopRef.current = () => {
        stopped = true;
        stream.getTracks().forEach((t) => t.stop());
      };
      const tick = async () => {
        if (stopped || !videoRef.current) return;
        try {
          const codes = await detector.detect(video);
          const val: string | undefined = codes?.[0]?.rawValue;
          if (val && val.includes('.')) {
            scanStopRef.current?.();
            await commitCode(val);
            return;
          }
        } catch {
          // ignore single frame errors
        }
        setTimeout(tick, 400);
      };
      tick();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Нет доступа к камере');
      setMode('enter');
    }
  };

  if (checking) return <div className="screen"><p>Проверка ключа…</p></div>;

  return (
    <div className="screen">
      <div className="card">
        <h2>Спаривание устройств</h2>
        <p className="muted">Нужен общий room key (AES-256). Ключ хранится только в этом браузере, на сервер не отправляется.</p>
        {err && <div className="error">{err}</div>}

        {mode === 'choose' && (
          <div className="row">
            <button onClick={create} disabled={busy}>{busy ? '…' : 'Создать ключ (первое устройство)'}</button>
            <button onClick={() => setMode('enter')}>У меня есть код / QR</button>
            <button onClick={startScan}>Сканировать камерой</button>
          </div>
        )}

        {mode === 'show' && (
          <div>
            <p>Покажите этот QR второму устройству. Потом нажмите «Готово».</p>
            {qrValue && <QRCodeSVG value={qrValue} size={220} />}
            <textarea readOnly value={qrValue} rows={3} style={{ width: '100%', marginTop: 8 }} />
            <div className="row">
              <button
                onClick={async () => {
                  const k = await loadRoomKey();
                  if (k) onReady(k);
                }}
              >
                Готово
              </button>
            </div>
          </div>
        )}

        {mode === 'enter' && (
          <div>
            <label>
              Код ключа (ns1.…)
              <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} style={{ width: '100%' }} />
            </label>
            <div className="row">
              <button disabled={busy || !code.trim()} onClick={() => commitCode(code)}>
                {busy ? '…' : 'Сохранить ключ'}
              </button>
              <button onClick={() => setMode('choose')}>Назад</button>
            </div>
          </div>
        )}

        {mode === 'scan' && (
          <div>
            <video ref={videoRef} style={{ width: '100%', background: '#000' }} muted playsInline />
            <div className="row">
              <button onClick={() => { scanStopRef.current?.(); setMode('enter'); }}>Ввести вручную</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
