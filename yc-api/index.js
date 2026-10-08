// Yandex Cloud Function ns-api — единая точка API мессенджера.
// Роуты:
//   GET  /health (и /api/health) — публично, только наличие env
//   POST /api/media/upload-init {mediaId, mimeType, size} → {sessionUrl}
//   POST /api/media/download {driveFileId, start?, end?} → {data: base64, total}
//   POST /api/push {messageId} → {ok: true}
// Все POST требуют Authorization: Bearer <Firebase ID token>, UID в ALLOWED_UIDS.
const { handleCors } = require('./lib/cors');
const { requireUid } = require('./lib/auth');
const { admin, allowedUids } = require('./lib/firebaseAdmin');
const { initResumableUpload, downloadBytes } = require('./lib/drive');
const webpush = require('web-push');

const MAX_CIPHER_BYTES = 12 * 1024 * 1024; // 10МБ + overhead AES-GCM
const CHUNK_BYTES = 1024 * 1024; // чанки скачивания 1МБ

let vapidSet = false;

function json(statusCode, obj, headers) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(obj),
  };
}

function errStatus(e) {
  return (e && e.status) || 500;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    const s = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function pathOf(event) {
  const raw = event.path || (event.http && event.http.path) || event.url || '/';
  return String(raw).split('?')[0].replace(/\/+$/, '') || '/';
}

function endsWith(path, suffix) {
  return path === suffix || path.endsWith(suffix);
}

async function health(corsHeaders) {
  const has = (n) => !!process.env[n];
  return json(200, {
    ok: true,
    env: {
      FIREBASE_SERVICE_ACCOUNT_JSON: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
      ALLOWED_UIDS: has('ALLOWED_UIDS'),
      GOOGLE_SERVICE_ACCOUNT_JSON: has('GOOGLE_SERVICE_ACCOUNT_JSON'),
      DRIVE_FOLDER_ID: has('DRIVE_FOLDER_ID'),
      VAPID_PUBLIC_KEY: has('VAPID_PUBLIC_KEY'),
      VAPID_PRIVATE_KEY: has('VAPID_PRIVATE_KEY'),
      FRONTEND_ORIGINS: has('FRONTEND_ORIGINS'),
    },
  }, corsHeaders);
}

async function uploadInit(event, corsHeaders) {
  const uid = await requireUid(event.headers || {});
  const body = parseBody(event);
  const { mediaId, mimeType, size } = body;
  if (!mediaId || typeof mediaId !== 'string' || mediaId.length > 100) {
    return json(400, { error: 'bad mediaId' }, corsHeaders);
  }
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return json(400, { error: 'only images supported' }, corsHeaders);
  }
  if (!size || typeof size !== 'number' || size <= 0 || size > MAX_CIPHER_BYTES) {
    return json(400, { error: 'bad size (max 10MB plaintext + overhead)' }, corsHeaders);
  }
  // Только ciphertext. Сервер байты не видит: клиент льёт их напрямую в sessionUrl.
  const { sessionUrl } = await initResumableUpload({ name: `${uid}_${mediaId}`, mimeType });
  return json(200, { sessionUrl }, corsHeaders);
}

async function download(event, corsHeaders) {
  await requireUid(event.headers || {});
  const body = parseBody(event);
  const { driveFileId } = body;
  let { start, end } = body;
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end < start || end - start + 1 > CHUNK_BYTES) {
    if (start !== undefined || end !== undefined) {
      return json(400, { error: `bad range (max chunk ${CHUNK_BYTES} bytes)` }, corsHeaders);
    }
  }
  const { bytes, total } = await downloadBytes({ fileId: driveFileId, start, end });
  return json(200, { data: bytes.toString('base64'), total }, corsHeaders);
}

async function push(event, corsHeaders) {
  const uid = await requireUid(event.headers || {});
  const { messageId } = parseBody(event);
  if (!messageId || typeof messageId !== 'string') {
    return json(400, { error: 'bad messageId' }, corsHeaders);
  }
  const { db } = admin();
  const msgSnap = await db.doc(`rooms/main/messages/${messageId}`).get();
  if (!msgSnap.exists) return json(404, { error: 'message not found' }, corsHeaders);
  const msg = msgSnap.data() || {};
  if (msg.senderId !== uid) return json(403, { error: 'not your message' }, corsHeaders);
  const peer = allowedUids().find((id) => id !== uid);
  if (!peer) return json(200, { ok: true, skipped: 'no peer' }, corsHeaders);
  const subSnap = await db.doc(`pushSubscriptions/${peer}`).get();
  if (!subSnap.exists) return json(200, { ok: true, skipped: 'no subscription' }, corsHeaders);
  const sub = (subSnap.data() || {}).subscription;
  if (!sub || !sub.endpoint) return json(200, { ok: true, skipped: 'bad subscription' }, corsHeaders);
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subj = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) throw Object.assign(new Error('Missing VAPID env'), { status: 500 });
  if (!vapidSet) {
    webpush.setVapidDetails(subj, pub, priv);
    vapidSet = true;
  }
  // Только служебные данные, без plaintext.
  try {
    await webpush.sendNotification(sub, JSON.stringify({ messageId, senderId: uid, ts: Date.now() }));
  } catch (e) {
    const status = e && e.statusCode;
    if (status === 404 || status === 410) {
      await db.doc(`pushSubscriptions/${peer}`).delete().catch(() => {});
      return json(200, { ok: true, cleaned: true }, corsHeaders);
    }
    throw e;
  }
  return json(200, { ok: true }, corsHeaders);
}

module.exports.handler = async function (event, context) {
  const method = event.httpMethod || (event.http && event.http.method) || 'GET';
  const path = pathOf(event);
  const headers = event.headers || {};

  const cors = handleCors(method, headers);
  if (cors.handled) return cors.handled;
  const corsHeaders = cors.headers;

  try {
    if (method === 'GET' && (path === '/health' || endsWith(path, '/api/health') || path === '/')) {
      if (path === '/') return json(200, { ok: true, routes: ['GET /health', 'POST /api/media/upload-init', 'POST /api/media/download', 'POST /api/push'] }, corsHeaders);
      return await health(corsHeaders);
    }
    if (method !== 'POST') return json(405, { error: 'Method not allowed' }, corsHeaders);
    if (endsWith(path, '/api/media/upload-init')) return await uploadInit(event, corsHeaders);
    if (endsWith(path, '/api/media/download')) return await download(event, corsHeaders);
    if (endsWith(path, '/api/push')) return await push(event, corsHeaders);
    return json(404, { error: 'not found' }, corsHeaders);
  } catch (e) {
    return json(errStatus(e), { error: e instanceof Error ? e.message : 'Server error' }, corsHeaders);
  }
};
