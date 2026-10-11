import { useRef } from 'react';
import {
  Bell,
  ImagePlus,
  KeyRound,
  LogOut,
  Moon,
  Sun,
  SunMoon,
  Trash2,
  X,
} from 'lucide-react';
import { AVATAR_COLORS, DEFAULT_SETTINGS, type LocalSettings } from '../lib/settings';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: LocalSettings;
  update: (patch: Partial<LocalSettings>) => void;
  resetAppearance: () => void;
  // Собеседник
  avatarUrl: string | null;
  onPickAvatar: (f: File) => void;
  onClearAvatar: () => void;
  // Обои
  wallpaperUrl: string | null;
  onPickWallpaper: (f: File) => void;
  onClearWallpaper: () => void;
  // Уведомления
  pushOn: boolean;
  pushBusy: boolean;
  onTogglePush: () => void;
  pushStatus: string | null;
  // Аккаунт и ключ
  email: string;
  onLogout: () => void;
  onShowKey: () => void;
  onWipeDevice: () => void;
  // Диагностика
  debugLines: string[];
}

export default function SettingsSheet(p: Props) {
  const avatarRef = useRef<HTMLInputElement | null>(null);
  const wallpaperRef = useRef<HTMLInputElement | null>(null);
  const s = p.settings;

  return (
    <>
      <div
        className={`sheet-backdrop${p.open ? ' open' : ''}`}
        onClick={p.onClose}
        aria-hidden
      />
      <aside className={`sheet${p.open ? ' open' : ''}`} aria-hidden={!p.open} aria-label="Настройки">
        <div className="sheet-head">
          <strong>Настройки</strong>
          <button className="icon-btn" onClick={p.onClose} aria-label="Закрыть настройки">
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">
          <div className="set-group">
            <h4>Собеседник</h4>
            <div className="set-row">
              <div className="grow">
                <div className="sub">Имя (видно только тебе)</div>
                <input
                  className="set-input"
                  value={s.peerName}
                  maxLength={40}
                  onChange={(e) => p.update({ peerName: e.target.value })}
                  placeholder="Собеседник"
                />
              </div>
            </div>
            <div className="set-row">
              <div className="grow">
                <div className="sub">Иконка</div>
                <div className="swatches" style={{ marginTop: 8 }}>
                  {AVATAR_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`swatch${!p.avatarUrl && s.avatarColor === c ? ' active' : ''}`}
                      style={{ background: c }}
                      onClick={() => {
                        p.onClearAvatar();
                        p.update({ avatarColor: c });
                      }}
                      aria-label={`Цвет ${c}`}
                    />
                  ))}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => avatarRef.current?.click()}>
                    <ImagePlus size={16} /> Своё фото
                  </button>
                  {p.avatarUrl && (
                    <button className="btn" onClick={p.onClearAvatar}>
                      <Trash2 size={16} /> Убрать фото
                    </button>
                  )}
                </div>
                <input
                  ref={avatarRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) p.onPickAvatar(f);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="set-group">
            <h4>Оформление</h4>
            <div className="set-row">
              <div className="grow">
                <div className="sub">Тема</div>
                <div className="segmented" style={{ marginTop: 8 }}>
                  <button
                    className={s.theme === 'system' ? 'active' : ''}
                    onClick={() => p.update({ theme: 'system' })}
                  >
                    <SunMoon size={15} /> Авто
                  </button>
                  <button
                    className={s.theme === 'light' ? 'active' : ''}
                    onClick={() => p.update({ theme: 'light' })}
                  >
                    <Sun size={15} /> Светлая
                  </button>
                  <button
                    className={s.theme === 'dark' ? 'active' : ''}
                    onClick={() => p.update({ theme: 'dark' })}
                  >
                    <Moon size={15} /> Тёмная
                  </button>
                </div>
              </div>
            </div>
            <div className="set-row">
              <div className="grow">
                <div className="sub">Обои чата (из галереи, только на этом устройстве)</div>
                <div className="row">
                  <button className="btn" onClick={() => wallpaperRef.current?.click()}>
                    <ImagePlus size={16} /> Выбрать
                  </button>
                  {p.wallpaperUrl && (
                    <button className="btn" onClick={p.onClearWallpaper}>
                      <Trash2 size={16} /> Убрать
                    </button>
                  )}
                </div>
                {p.wallpaperUrl && (
                  <div
                    className="wallpaper-preview"
                    style={{ backgroundImage: `url("${p.wallpaperUrl}")` }}
                  />
                )}
                <input
                  ref={wallpaperRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) p.onPickWallpaper(f);
                  }}
                />
              </div>
            </div>
            <div className="set-row">
              <div className="grow">
                Стеклянные сообщения
                <div className="sub">Матовое стекло вместо сплошной заливки</div>
              </div>
            </div>
            <div className="set-row">
              <div className="grow">Мои — стекло</div>
              <button
                className="switch"
                role="switch"
                aria-checked={s.bubbleGlassMine}
                onClick={() => p.update({ bubbleGlassMine: !s.bubbleGlassMine })}
                aria-label="Мои сообщения стеклом"
              />
            </div>
            <div className="set-row">
              <div className="grow">Чужие — стекло</div>
              <button
                className="switch"
                role="switch"
                aria-checked={s.bubbleGlassTheirs}
                onClick={() => p.update({ bubbleGlassTheirs: !s.bubbleGlassTheirs })}
                aria-label="Чужие сообщения стеклом"
              />
            </div>
            <div className="set-row">
              <div className="grow">Цвет моих</div>
              <input
                type="color"
                className="colorwell"
                value={s.bubbleColorMine ?? DEFAULT_SETTINGS.bubbleColorMine ?? '#1c1c1e'}
                onChange={(e) => p.update({ bubbleColorMine: e.target.value })}
                aria-label="Цвет моих сообщений"
              />
              {s.bubbleColorMine && (
                <button className="btn" onClick={() => p.update({ bubbleColorMine: null })}>
                  Сброс
                </button>
              )}
            </div>
            <div className="set-row">
              <div className="grow">Цвет чужих</div>
              <input
                type="color"
                className="colorwell"
                value={s.bubbleColorTheirs ?? '#ffffff'}
                onChange={(e) => p.update({ bubbleColorTheirs: e.target.value })}
                aria-label="Цвет чужих сообщений"
              />
              {s.bubbleColorTheirs && (
                <button className="btn" onClick={() => p.update({ bubbleColorTheirs: null })}>
                  Сброс
                </button>
              )}
            </div>
            <div className="row">
              <button className="btn" onClick={p.resetAppearance}>
                Сбросить оформление
              </button>
            </div>
          </div>

          <div className="set-group">
            <h4>Уведомления</h4>
            <div className="set-row">
              <div className="grow">
                <Bell size={16} style={{ verticalAlign: -3 }} /> Push
                {p.pushStatus && <div className="sub">{p.pushStatus}</div>}
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={p.pushOn}
                disabled={p.pushBusy}
                onClick={p.onTogglePush}
                aria-label="Push-уведомления"
              />
            </div>
            {!p.pushOn && (
              <div className="sub">
                iOS: открой сайт с иконки «На экране Домой», затем включи.
              </div>
            )}
          </div>

          <div className="set-group">
            <h4>Ключ и безопасность</h4>
            <div className="row">
              <button className="btn" onClick={p.onShowKey}>
                <KeyRound size={16} /> QR ключа
              </button>
              <button className="btn" onClick={p.onWipeDevice}>
                <Trash2 size={16} /> Удалить ключ
              </button>
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              Сквозное шифрование AES-256. Сервер видит только шифротекст.
            </div>
          </div>

          <div className="set-group">
            <h4>Аккаунт</h4>
            <div className="set-row">
              <div className="grow">{p.email}</div>
              <button className="btn" onClick={p.onLogout}>
                <LogOut size={16} /> Выйти
              </button>
            </div>
          </div>

          <div className="set-group">
            <h4>Диагностика</h4>
            {p.debugLines.map((l, i) => (
              <div className="small muted" key={i}>
                {l}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
