// Тема оформления: light / dark. Выбор хранится в localStorage,
// по умолчанию — системная тема. Применяется через data-theme на <html>
// (первичное значение ставит инлайн-скрипт в index.html, чтобы не мигало).
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'ns-theme';
const META_LIGHT = '#f6f6f4';
const META_DARK = '#000000';

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return systemTheme();
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? META_DARK : META_LIGHT);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // ignore
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);
  return { theme, toggle };
}
