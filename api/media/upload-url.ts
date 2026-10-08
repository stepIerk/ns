import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireUid, httpError } from '../_lib/auth.js';
import { b2 } from '../_lib/b2.js';

const MAX_CIPHER_BYTES = 12 * 1024 * 1024; // 10МБ + overhead AES-GCM

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const uid = await requireUid(req);
    const { mediaId, mimeType, size } = (req.body ?? {}) as {
      mediaId?: string;
      mimeType?: string;
      size?: number;
    };
    if (!mediaId || typeof mediaId !== 'string' || mediaId.length > 100) {
      res.status(400).json({ error: 'bad mediaId' });
      return;
    }
    if (!mimeType || !mimeType.startsWith('image/')) {
      res.status(400).json({ error: 'only images supported' });
      return;
    }
    if (!size || typeof size !== 'number' || size <= 0 || size > MAX_CIPHER_BYTES) {
      res.status(400).json({ error: 'bad size (max 10MB plaintext + overhead)' });
      return;
    }
    const { s3, bucket } = b2();
    // Только ciphertext. Сервер файл не видит и не проксирует.
    const objectKey = `media/${uid}/${mediaId}`;
    const putUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: 'application/octet-stream',
      }),
      { expiresIn: 300 },
    );
    res.status(200).json({ putUrl, objectKey });
  } catch (e) {
    httpError(res, e);
  }
}
