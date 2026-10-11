import { getFirebase } from './firebase';

/**
 * POST к serverless API с Firebase ID token.
 * По умолчанию same-origin ('/api/...'). Если фронт отделён от API
 * (статика на GH Pages, API — Yandex Function) —
 * задайте VITE_API_BASE_URL=https://functions.yandexcloud.net/<id> (без слэша).
 * Yandex не маршрутизирует по пути, поэтому в тело всегда кладём `action`,
 * а при заданном base постим в корень функции. Vercel-роуты поле action игнорируют.
 */
function actionFor(path: string): string {
  if (path.endsWith('/api/media/upload-init')) return 'media.upload-init';
  if (path.endsWith('/api/media/upload-chunk')) return 'media.upload-chunk';
  if (path.endsWith('/api/media/download')) return 'media.download';
  if (path.endsWith('/api/push')) return 'push';
  throw new Error(`unknown api path: ${path}`);
}

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '');
  if (base) return `${base}/`;
  return path;
}

export async function authedPost<T>(
  path: string,
  body: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const fb = getFirebase();
  if (!fb?.auth.currentUser) throw new Error('Нет auth-сессии');
  const token = await fb.auth.currentUser.getIdToken();
  // Висящий сокет (холодный старт / обрыв на edge) без таймаута крутит
  // спиннер вечно и кончается браузерным ERR_TIMED_OUT без диагностики.
  // timeoutMs берём чуть ниже execution-timeout функции (30с): если функция
  // жива, но медленна — её 504 придёт раньше и с диагнозом.
  const timeoutMs = opts?.timeoutMs;
  const ctrl = typeof timeoutMs === 'number' && timeoutMs > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // НЕ Authorization: invoke-endpoint Яндекса перехватывает Bearer-токен
        // как свой IAM-токен и отвечает 403 до того, как запрос дойдёт до функции.
        'X-Firebase-Token': token,
      },
      body: JSON.stringify({ action: actionFor(path), ...body }),
      ...(ctrl ? { signal: ctrl.signal } : null),
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
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(
        `Функция не отвечает (${Math.round((timeoutMs ?? 0) / 1000)}с) — холодный старт или обрыв сети, попробуй ещё раз`,
        { cause: e },
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
