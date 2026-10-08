import { getFirebase } from './firebase';

/**
 * POST к serverless API с Firebase ID token.
 * По умолчанию same-origin ('/api/...'). Если фронт отделён от API
 * (например, статика на GitHub Pages, API на другом домене) —
 * задайте VITE_API_BASE_URL=https://api-ваш-домен (без слэша в конце).
 */
function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '');
  if (base) return `${base}${path}`;
  return path;
}

export async function authedPost<T>(path: string, body: unknown): Promise<T> {
  const fb = getFirebase();
  if (!fb?.auth.currentUser) throw new Error('Нет auth-сессии');
  const token = await fb.auth.currentUser.getIdToken();
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ?? `API ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  return data as T;
}
