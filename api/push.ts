import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { admin, allowedUids } from './_lib/firebaseAdmin.js';
import { requireUid, httpError } from './_lib/auth.js';

let vapidSet = false;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const uid = await requireUid(req);
    const { messageId } = (req.body ?? {}) as { messageId?: string };
    if (!messageId || typeof messageId !== 'string') {
      res.status(400).json({ error: 'bad messageId' });
      return;
    }
    const { db } = admin();
    const msgSnap = await db.doc(`rooms/main/messages/${messageId}`).get();
    if (!msgSnap.exists) {
      res.status(404).json({ error: 'message not found' });
      return;
    }
    const msg = msgSnap.data() as { senderId?: string };
    if (msg.senderId !== uid) {
      res.status(403).json({ error: 'not your message' });
      return;
    }
    // Второй пользователь = другой UID из allowlist.
    const peer = allowedUids().find((id: string) => id !== uid);
    if (!peer) {
      res.status(200).json({ ok: true, skipped: 'no peer' });
      return;
    }
    const subSnap = await db.doc(`pushSubscriptions/${peer}`).get();
    if (!subSnap.exists) {
      res.status(200).json({ ok: true, skipped: 'no subscription' });
      return;
    }
    const sub = (subSnap.data() as { subscription?: unknown }).subscription as
      | webpush.PushSubscription
      | undefined;
    if (!sub?.endpoint) {
      res.status(200).json({ ok: true, skipped: 'bad subscription' });
      return;
    }
    const pub = process.env.VAPID_PUBLIC_KEY ?? '';
    const priv = process.env.VAPID_PRIVATE_KEY ?? '';
    const subj = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';
    if (!pub || !priv) throw Object.assign(new Error('Missing VAPID env'), { status: 500 });
    if (!vapidSet) {
      webpush.setVapidDetails(subj, pub, priv);
      vapidSet = true;
    }
    // Только служебные данные, без plaintext.
    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({ messageId, senderId: uid, ts: Date.now() }),
      );
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        await db.doc(`pushSubscriptions/${peer}`).delete().catch(() => {});
        res.status(200).json({ ok: true, cleaned: true });
        return;
      }
      throw e;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    httpError(res, e);
  }
}
