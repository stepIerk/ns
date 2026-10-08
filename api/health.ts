import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Диагностика без тяжёлых импортов (без firebase-admin/aws-sdk).
 * Если падает и он — проблема в рантайме проекта, а не в конкретном роуте.
 * GET /api/health — публично, секретов НЕ возвращает, только наличие env.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const has = (n: string) => (process.env[n] ? true : false);
    res.status(200).json({
      ok: true,
      env: {
        FIREBASE_SERVICE_ACCOUNT_JSON: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
        ALLOWED_UIDS: has('ALLOWED_UIDS'),
        B2_ENDPOINT: has('B2_ENDPOINT'),
        B2_BUCKET: has('B2_BUCKET'),
        B2_KEY_ID: has('B2_KEY_ID'),
        B2_APP_KEY: has('B2_APP_KEY'),
        B2_REGION: has('B2_REGION'),
        VAPID_PUBLIC_KEY: has('VAPID_PUBLIC_KEY'),
        VAPID_PRIVATE_KEY: has('VAPID_PRIVATE_KEY'),
        FRONTEND_ORIGINS: has('FRONTEND_ORIGINS'),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'health failed' });
  }
}
