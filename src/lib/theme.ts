// Тема оформления: light / dark / system. Выбор хранится не здесь,
// а в локальных настройках (lib/settings); хук ниже — только применение.
import { useEffect, useState } from 'react';
import type { ThemeChoice } from './settings';

export type Theme = 'light' | 'dark';

const META_LIGHT = '#f6f6f4';
const META_DARK = '#000000';

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'system' ? systemTheme() : choice;
}

export function applyThemeValue(t: Theme): void {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? META_DARK : META_LIGHT);
}

/** Применить выбор темы и следить за системой в режиме system. */
export function useApplyTheme(choice: ThemeChoice): Theme {
  const [sysDark, setSysDark] = useState(() => systemTheme() === 'dark');
  useEffect(() => {
    if (choice !== 'system') return;
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [choice]);
  const effective: Theme = choice === 'system' ? (sysDark ? 'dark' : 'light') : choice;
  useEffect(() => {
    applyThemeValue(effective);
  }, [effective]);
  return effective;
}

// Совместимость: разовый хук с тогглом (старые вызовы).
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(systemTheme);
  useEffect(() => {
    applyThemeValue(theme);
    try {
      localStorage.setItem('ns-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };
}

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('ns-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return systemTheme();
}

export function applyTheme(t: Theme): void {
  applyThemeValue(t);
}
