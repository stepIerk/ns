import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * CORS для случая, когда фронт отделён от API
 * (статика на GitHub Pages, API на своём домене).
 * Same-origin запросы работают и без этого.
 *
 * FRONTEND_ORIGINS — список через запятую, например:
 * https://stepierk.github.io,https://ваш-домен.ru
 */
function configuredOrigins(): string[] {
  return (process.env.FRONTEND_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function requestOrigin(req: VercelRequest): string | null {
  const o = req.headers.origin;
  if (typeof o === 'string' && o.length > 0) return o.replace(/\/+$/, '');
  return null;
}

/**
 * Проставляет CORS-заголовки и обрабатывает preflight.
 * Вернуть true — значит ответ уже отправлен, хендлер должен выйти.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = requestOrigin(req);
  const allowed = origin !== null && configuredOrigins().includes(origin);
  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (allowed) {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Firebase-Token');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
    } else {
      res.status(403).json({ error: 'CORS: origin not allowed' });
    }
    return true;
  }
  return false;
}
