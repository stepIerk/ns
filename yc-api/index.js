// Yandex Cloud Function ns-api — единая точка API мессенджера.
// Invoke-URL Яндекса не маршрутизирует по пути (всё после ID функции — ошибка),
// поэтому: GET корня = health, POST корня с полем action в теле:
//   {action:'media.upload-init', mediaId, mimeType, size} → {sessionUrl}
//   {action:'media.upload-chunk', sessionUrl, start, end, total, data(b64)} → {done, fileId?}
//   {action:'media.download', driveFileId, start?, end?} → {data: base64, total}
//   {action:'push', messageId} → {ok: true}
// Все POST требуют X-Firebase-Token: <Firebase ID token>, UID в ALLOWED_UIDS.
const { handleCors } = require('./lib/cors');
const { requireUid } = require('./lib/auth');
const { allowedUids, getDoc, deleteDoc } = require('./lib/firestore');
const { initResumableUpload, uploadChunk, downloadBytes } = require('./lib/drive');
const webpush = require('web-push');

const MAX_CIPHER_BYTES = 12 * 1024 * 1024; // 10МБ + overhead AES-GCM
const CHUNK_BYTES = 1024 * 1024; // чанки скачивания/загрузки 1МБ (запрос к функции < 3.5МБ)

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
  const body = event.parsedBody || parseBody(event);
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
  // Только ciphertext. Сервер байты видит лишь транзитом чанками:
  // клиент шлёт base64-чанки в media.upload-chunk, функция доливает их
  // в resumable-сессию серверным PUT (без CORS — браузер к Google не ходит).
  const { sessionUrl } = await initResumableUpload({
    name: `${uid}_${mediaId}`,
    mimeType,
  });
  return json(200, { sessionUrl }, corsHeaders);
}

async function uploadChunkHandler(event, corsHeaders) {
  await requireUid(event.headers || {});
  const body = event.parsedBody || parseBody(event);
  const { sessionUrl, start, end, total, data } = body;
  if (typeof sessionUrl !== 'string' || !sessionUrl.startsWith('https://www.googleapis.com/upload/')) {
    return json(400, { error: 'bad sessionUrl' }, corsHeaders);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(total) ||
      start < 0 || end < start || end >= total || total <= 0 || total > MAX_CIPHER_BYTES) {
    return json(400, { error: `bad range (max file ${MAX_CIPHER_BYTES} bytes)` }, corsHeaders);
  }
  if (end - start + 1 > CHUNK_BYTES) {
    return json(400, { error: `bad chunk (max ${CHUNK_BYTES} bytes)` }, corsHeaders);
  }
  if (typeof data !== 'string' || data.length === 0) {
    return json(400, { error: 'bad data' }, corsHeaders);
  }
  let chunk;
  try {
    chunk = Buffer.from(data, 'base64');
  } catch {
    return json(400, { error: 'bad data encoding' }, corsHeaders);
  }
  if (chunk.length !== end - start + 1) {
    return json(400, { error: 'chunk size mismatch' }, corsHeaders);
  }
  const r = await uploadChunk({ sessionUrl, start, end, total, chunk });
  return json(200, r, corsHeaders);
}

async function download(event, corsHeaders) {
  await requireUid(event.headers || {});
  const body = event.parsedBody || parseBody(event);
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
  const { messageId } = event.parsedBody || parseBody(event);
  if (!messageId || typeof messageId !== 'string') {
    return json(400, { error: 'bad messageId' }, corsHeaders);
  }
  const msgSnap = await getDoc(`rooms/main/messages/${messageId}`);
  if (!msgSnap.exists) return json(404, { error: 'message not found' }, corsHeaders);
  const msg = msgSnap.data || {};
  if (msg.senderId !== uid) return json(403, { error: 'not your message' }, corsHeaders);
  const peer = allowedUids().find((id) => id !== uid);
  if (!peer) return json(200, { ok: true, skipped: 'no peer' }, corsHeaders);
  const subSnap = await getDoc(`pushSubscriptions/${peer}`);
  if (!subSnap.exists) return json(200, { ok: true, skipped: 'no subscription' }, corsHeaders);
  const sub = (subSnap.data || {}).subscription;
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
      await deleteDoc(`pushSubscriptions/${peer}`).catch(() => {});
      return json(200, { ok: true, cleaned: true }, corsHeaders);
    }
    throw e;
  }
  return json(200, { ok: true }, corsHeaders);
}

module.exports.handler = async function (event, context) {
  const method = event.httpMethod || (event.http && event.http.method) || 'GET';
  const headers = event.headers || {};

  const cors = handleCors(method, headers);
  if (cors.handled) return cors.handled;
  const corsHeaders = cors.headers;

  try {
    // GET корня = health (заодно канарейка: раз ответил — все импорты встали).
    if (method === 'GET') return await health(corsHeaders);
    if (method !== 'POST') return json(405, { error: 'Method not allowed' }, corsHeaders);
    const body = parseBody(event);
    event.parsedBody = body;
    const action = body.action;
    if (action === 'media.upload-init') return await uploadInit(event, corsHeaders);
    if (action === 'media.upload-chunk') return await uploadChunkHandler(event, corsHeaders);
    if (action === 'media.download') return await download(event, corsHeaders);
    if (action === 'push') return await push(event, corsHeaders);
    return json(404, { error: 'unknown action' }, corsHeaders);
  } catch (e) {
    return json(errStatus(e), { error: e instanceof Error ? e.message : 'Server error' }, corsHeaders);
  }
};
