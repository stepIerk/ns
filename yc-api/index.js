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
// Чанк загрузки обязан быть кратен 256КБ (требование resumable-протокола Drive
// для НЕпоследних чанков): некратный Google фиксирует только до границы 256КБ —
// позиция уезжает, следующая догрузка падает 503 «upload offset exceeds already
// uploaded size» (реальный баг с 1500*1000). 2МиБ: base64 ≈ 2.8МБ — влезает
// в лимит запроса/ответа функции 3.5МБ. Клиент берёт размер из health
// (maxChunk), старые клиенты шлют 1МБ — тоже кратно 256КБ и валидно.
const DRIVE_CHUNK_ALIGN = 256 * 1024;
const CHUNK_BYTES = 8 * DRIVE_CHUNK_ALIGN;

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
    maxChunk: CHUNK_BYTES, // клиент подстраивает размер чанка (см. src/lib/api.ts)
    env: {
      FIREBASE_SERVICE_ACCOUNT_JSON: has('FIREBASE_SERVICE_ACCOUNT_JSON'),
      ALLOWED_UIDS: has('ALLOWED_UIDS'),
      GOOGLE_OAUTH_CLIENT_ID: has('GOOGLE_OAUTH_CLIENT_ID'),
      GOOGLE_OAUTH_CLIENT_SECRET: has('GOOGLE_OAUTH_CLIENT_SECRET'),
      GOOGLE_OAUTH_REFRESH_TOKEN: has('GOOGLE_OAUTH_REFRESH_TOKEN'),
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
  if (!mimeType || typeof mimeType !== 'string' ||
      (!mimeType.startsWith('image/') && !mimeType.startsWith('audio/') && !mimeType.startsWith('video/'))) {
    return json(400, { error: 'only images, audio and video supported' }, corsHeaders);
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
  // Push-payload: только метадата + шифротекст. Plaintext тут нет и не будет:
  // текст расшифровывает сам получатель в своём Service Worker комнатным ключом
  // (E2E цел — сервер, Apple и Google видят лишь шифротекст; сам web-push
  // шифрует payload на ключ подписки). Шифр кладём, только если весь payload
  // влезает в ~2.8КБ (лимит APNs ~4КБ) — длинные тексты уедут заглушкой по kind,
  // расшифровка всё равно видна в открытом чате.
  const payload = {
    messageId,
    senderId: uid,
    ts: Date.now(),
    kind: msg.kind || 'text',
  };
  if (msg.kind === 'voice' && typeof msg.durationMs === 'number') {
    payload.durationMs = msg.durationMs;
  }
  if (typeof msg.ciphertext === 'string' && typeof msg.iv === 'string') {
    const withCipher = { ...payload, ciphertext: msg.ciphertext, iv: msg.iv };
    if (JSON.stringify(withCipher).length <= 2800) {
      payload.ciphertext = msg.ciphertext;
      payload.iv = msg.iv;
    }
  }
  // Только служебные данные, без plaintext.
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
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
