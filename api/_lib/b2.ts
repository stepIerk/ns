import { S3Client } from '@aws-sdk/client-s3';

let client: S3Client | null = null;

/**
 * Регион выводим из endpoint (s3.<region>.backblazeb2.com),
 * чтобы подпись всегда совпадала с хостом — руками B2_REGION
 * можно не выверять. Path-style + без checksum-заголовков:
 * B2 их не ждёт, а браузерный PUT шлёт только Content-Type.
 */
function regionFromEndpoint(endpoint: string, fallback: string): string {
  const m = endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/i);
  return (m?.[1] ?? fallback).trim() || 'us-east-005';
}

export function b2(): { s3: S3Client; bucket: string } {
  const bucket = process.env.B2_BUCKET ?? '';
  const endpoint = process.env.B2_ENDPOINT ?? '';
  const keyId = process.env.B2_KEY_ID ?? '';
  const appKey = process.env.B2_APP_KEY ?? '';
  if (!bucket || !endpoint || !keyId || !appKey) {
    throw Object.assign(new Error('Missing B2 env (B2_BUCKET/B2_ENDPOINT/B2_KEY_ID/B2_APP_KEY)'), {
      status: 500,
    });
  }
  const region = regionFromEndpoint(endpoint, process.env.B2_REGION ?? '');
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: appKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return { s3: client, bucket };
}
