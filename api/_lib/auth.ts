import type { VercelRequest } from '@vercel/node';
import { admin, allowedUids } from './firebaseAdmin.js';

export async function requireUid(req: VercelRequest): Promise<string> {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 });
  const { auth } = admin();
  const decoded = await auth.verifyIdToken(token);
  const allow = allowedUids();
  if (allow.length > 0 && !allow.includes(decoded.uid)) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return decoded.uid;
}

export function httpError(res: { status: (c: number) => { json: (b: unknown) => void } }, e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  const message = e instanceof Error ? e.message : 'Server error';
  res.status(status).json({ error: message });
}
