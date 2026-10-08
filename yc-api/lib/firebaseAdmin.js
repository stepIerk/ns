// Firebase Admin для Yandex Cloud Functions (CommonJS).
// Ключ SA берём из env FIREBASE_SERVICE_ACCOUNT_JSON (или Lockbox → env).
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

let inited = false;

function admin() {
  if (!inited) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw Object.assign(new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON'), { status: 500 });
    const creds = JSON.parse(raw);
    if (getApps().length === 0) {
      initializeApp({ credential: cert(creds), projectId: creds.project_id });
    }
    inited = true;
  }
  return { auth: getAuth(), db: getFirestore() };
}

function allowedUids() {
  return (process.env.ALLOWED_UIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { admin, allowedUids };
