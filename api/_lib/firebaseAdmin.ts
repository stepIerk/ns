import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let inited = false;

export function admin() {
  if (!inited) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
    const creds = JSON.parse(raw) as Record<string, unknown>;
    if (getApps().length === 0) {
      initializeApp({ credential: cert(creds as never), projectId: creds.project_id as string });
    }
    inited = true;
  }
  return { auth: getAuth(), db: getFirestore() };
}

export function allowedUids(): string[] {
  return (process.env.ALLOWED_UIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
