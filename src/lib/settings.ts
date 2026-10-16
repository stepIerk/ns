import { useCallback, useState } from 'react';

// Локальные настройки устройства (только этот браузер, на сервер не едут).
// Примитивы — localStorage, картинки (обои, аватар) — IDB-ассеты (см. lib/db).

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface LocalSettings {
  peerName: string; // имя собеседника (дефолт «Собеседник»)
  avatarColor: string; // фон буквенного аватара (hex)
  theme: ThemeChoice;
  bubbleGlassMine: boolean;
  bubbleGlassTheirs: boolean;
  bubbleColorMine: string | null; // null = цвет темы
  bubbleColorTheirs: string | null;
  // Кружочки (видео): форма purely local — кроп только на фронте, в файле прямоугольник.
  videoShape: 'circle' | 'rounded'; // круг / скруглённый квадрат
  videoRadius: number; // радиус для 'rounded', px (8–80)
}

const KEY = 'ns-settings-v1';

export const DEFAULT_SETTINGS: LocalSettings = {
  peerName: 'Собеседник',
  avatarColor: '#5b5bd6',
  theme: 'system',
  bubbleGlassMine: false,
  bubbleGlassTheirs: false,
  bubbleColorMine: null,
  bubbleColorTheirs: null,
  videoShape: 'circle',
  videoRadius: 28,
};

export const AVATAR_COLORS = [
  '#5b5bd6',
  '#0e7c5b',
  '#b3541e',
  '#a11e5c',
  '#1e6fb8',
  '#6d28d9',
  '#333333',
];

function load(): LocalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw) as Partial<LocalSettings>;
    return {
      peerName:
        typeof p.peerName === 'string' && p.peerName.trim()
          ? p.peerName.trim().slice(0, 40)
          : DEFAULT_SETTINGS.peerName,
      avatarColor:
        typeof p.avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.avatarColor)
          ? p.avatarColor
          : DEFAULT_SETTINGS.avatarColor,
      theme: p.theme === 'light' || p.theme === 'dark' || p.theme === 'system' ? p.theme : 'system',
      bubbleGlassMine: p.bubbleGlassMine === true,
      bubbleGlassTheirs: p.bubbleGlassTheirs === true,
      bubbleColorMine:
        typeof p.bubbleColorMine === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.bubbleColorMine)
          ? p.bubbleColorMine
          : null,
      bubbleColorTheirs:
        typeof p.bubbleColorTheirs === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.bubbleColorTheirs)
          ? p.bubbleColorTheirs
          : null,
      videoShape: p.videoShape === 'rounded' ? 'rounded' : 'circle',
      videoRadius:
        typeof p.videoRadius === 'number' && Number.isFinite(p.videoRadius)
          ? Math.min(80, Math.max(8, Math.round(p.videoRadius)))
          : DEFAULT_SETTINGS.videoRadius,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useLocalSettings(): {
  settings: LocalSettings;
  update: (patch: Partial<LocalSettings>) => void;
  reset: () => void;
} {
  const [settings, setSettings] = useState<LocalSettings>(load);
  const update = useCallback((patch: Partial<LocalSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // переполнение/приватный режим — живём до перезагрузки
      }
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  }, []);
  return { settings, update, reset };
}
