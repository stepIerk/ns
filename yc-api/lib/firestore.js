// Firebase БЕЗ firebase-admin (его дерево ломается установщиком Yandex).
// - Проверка ID token: подпись RS256 ключами Google + aud/iss (как Admin SDK).
// - Чтение/удаление документов: Firestore REST API с токеном service account.
// Env те же: FIREBASE_SERVICE_ACCOUNT_JSON, ALLOWED_UIDS.
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let fbAuthClient = null;
let certsCache = { certs: null, expiresAt: 0 };

function fbCreds() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw Object.assign(new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON'), { status: 500 });
  return JSON.parse(raw);
}

function projectId() {
  const pid = fbCreds().project_id;
  if (!pid) throw Object.assign(new Error('Bad service account JSON'), { status: 500 });
  return pid;
}

function allowedUids() {
  return (process.env.ALLOWED_UIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fbAccessToken() {
  if (process.env.FB_ACCESS_TOKEN_OVERRIDE) return process.env.FB_ACCESS_TOKEN_OVERRIDE; // только для локальных тестов
  if (!fbAuthClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: fbCreds(),
      scopes: ['https://www.googleapis.com/auth/datastore'],
    });
    fbAuthClient = await auth.getClient();
  }
  const res = await fbAuthClient.getAccessToken();
  const token = typeof res === 'string' ? res : res && res.token;
  if (!token) throw Object.assign(new Error('Firestore auth failed'), { status: 500 });
  return token;
}

async function getCerts() {
  if (certsCache.certs && Date.now() < certsCache.expiresAt) return certsCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw Object.assign(new Error('Google certs fetch failed'), { status: 502 });
  const certs = await res.json();
  let maxAge = 3600;
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  if (m) maxAge = Math.min(parseInt(m[1], 10), 86400);
  certsCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

/** Проверка Firebase ID token. Возвращает payload (uid в .sub). */
async function verifyIdToken(idToken) {
  const pid = projectId();
  let kid = null;
  try {
    const decoded = jwt.decode(idToken, { complete: true });
    kid = decoded && decoded.header && decoded.header.kid;
  } catch {
    throw Object.assign(new Error('Bad token'), { status: 401 });
  }
  const certs = await getCerts();
  const cert = (kid && certs[kid]) || null;
  if (!cert) throw Object.assign(new Error('Bad token key'), { status: 401 });
  try {
    const payload = jwt.verify(idToken, cert, {
      algorithms: ['RS256'],
      audience: pid,
      issuer: `https://securetoken.google.com/${pid}`,
    });
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw Object.assign(new Error('Bad token'), { status: 401 });
    }
    return payload;
  } catch (e) {
    if (e && e.status) throw e;
    throw Object.assign(new Error('Invalid token'), { status: 401 });
  }
}

function docUrl(path) {
  return `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents/${path}`;
}

function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromValue);
  if ('mapValue' in v) {
    const out = {};
    const fields = (v.mapValue && v.mapValue.fields) || {};
    for (const k of Object.keys(fields)) out[k] = fromValue(fields[k]);
    return out;
  }
  return null;
}

async function getDoc(path) {
  const token = await fbAccessToken();
  const res = await fetch(docUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return { exists: false, data: null };
  if (!res.ok) throw Object.assign(new Error(`Firestore read failed: ${res.status}`), { status: 502 });
  const data = await res.json();
  return { exists: true, data: fromFields(data.fields || {}) };
}

function fromFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fromValue(fields[k]);
  return out;
}

async function deleteDoc(path) {
  const token = await fbAccessToken();
  const res = await fetch(docUrl(path), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200 && res.status !== 404) {
    throw Object.assign(new Error(`Firestore delete failed: ${res.status}`), { status: 502 });
  }
}

module.exports = { allowedUids, verifyIdToken, getDoc, deleteDoc };
