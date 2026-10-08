import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireUid, httpError } from '../_lib/auth.js';
import { applyCors } from '../_lib/cors.js';
import { b2 } from '../_lib/b2.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    await requireUid(req);
    const { objectKey } = (req.body ?? {}) as { objectKey?: string };
    if (!objectKey || typeof objectKey !== 'string' || !objectKey.startsWith('media/')) {
      res.status(400).json({ error: 'bad objectKey' });
      return;
    }
    if (objectKey.includes('..')) {
      res.status(400).json({ error: 'bad objectKey' });
      return;
    }
    const { s3, bucket } = b2();
    const getUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      { expiresIn: 600 },
    );
    res.status(200).json({ getUrl });
  } catch (e) {
    httpError(res, e);
  }
}
