import { S3Client } from '@aws-sdk/client-s3';

let client: S3Client | null = null;

export function b2(): { s3: S3Client; bucket: string } {
  const bucket = process.env.B2_BUCKET ?? '';
  const endpoint = process.env.B2_ENDPOINT ?? '';
  const region = process.env.B2_REGION ?? 'eu-central-003';
  const keyId = process.env.B2_KEY_ID ?? '';
  const appKey = process.env.B2_APP_KEY ?? '';
  if (!bucket || !endpoint || !keyId || !appKey) {
    throw Object.assign(new Error('Missing B2 env (B2_BUCKET/B2_ENDPOINT/B2_KEY_ID/B2_APP_KEY)'), {
      status: 500,
    });
  }
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: appKey },
      forcePathStyle: false,
    });
  }
  return { s3: client, bucket };
}
