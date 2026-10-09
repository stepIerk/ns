// Google Drive через service account (вариант A: Drive самого SA).
// Scope drive.file — только файлы, созданные приложением. Байты файлов
// через сервер НЕ идут при загрузке: функция лишь открывает resumable-сессию
// и отдаёт sessionUrl, клиент льёт шифротекст напрямую в Google.
// Скачивание — прокси чанками (Drive не умеет presigned-ссылки),
// сервер при этом видит только шифротекст.
const { google } = require('googleapis');

const FOLDER_NAME = 'ns-messenger';

let authClient = null;
let folderIdCache = null;

function saCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw Object.assign(new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON'), { status: 500 });
  return JSON.parse(raw);
}

async function getAuthClient() {
  if (!authClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: saCredentials(),
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    authClient = await auth.getClient();
  }
  return authClient;
}

async function accessToken() {
  const client = await getAuthClient();
  const res = await client.getAccessToken();
  const token = typeof res === 'string' ? res : res && res.token;
  if (!token) throw Object.assign(new Error('Drive auth failed'), { status: 500 });
  return token;
}

async function ensureFolderId() {
  if (process.env.DRIVE_FOLDER_ID) return process.env.DRIVE_FOLDER_ID.trim();
  if (folderIdCache) return folderIdCache;
  const token = await accessToken();
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!list.ok) throw Object.assign(new Error(`Drive folder lookup failed: ${list.status}`), { status: 502 });
  const data = await list.json();
  if (data.files && data.files.length > 0) {
    folderIdCache = data.files[0].id;
    return folderIdCache;
  }
  const created = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!created.ok) throw Object.assign(new Error(`Drive folder create failed: ${created.status}`), { status: 502 });
  folderIdCache = (await created.json()).id;
  return folderIdCache;
}

/** Открыть resumable-сессию загрузки. Возвращает sessionUrl для прямого PUT клиента.
 * ВАЖНО для браузера: upload-фронтенд Google привязывает CORS будущей сессии
 * к заголовку Origin запроса инициации. Без него ответы на PUT из браузера
 * приходят без ACAO (и с 403) — см. доки GCS resumable uploads.
 * Поэтому пробрасываем Origin фронтенда (тот же, что браузер пришлёт на PUT).
 */
async function initResumableUpload({ name, mimeType, origin }) {
  const token = await accessToken();
  const folderId = await ensureFolderId();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
  };
  if (origin && typeof origin === 'string' && /^https:\/\/[^/]+$/.test(origin.trim())) {
    headers.Origin = origin.trim();
  }
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, parents: [folderId], appProperties: { app: 'ns' } }),
  });
  if (!res.ok) throw Object.assign(new Error(`Drive upload init failed: ${res.status}`), { status: 502 });
  const sessionUrl = res.headers.get('location');
  if (!sessionUrl) throw Object.assign(new Error('Drive upload init: no session url'), { status: 502 });
  return { sessionUrl };
}

/**
 * Скачать чанк шифротекста. start/end — байтовые границы (оба включительно).
 * Возвращает { bytes: Buffer, total } — total из Content-Range.
 */
async function downloadBytes({ fileId, start, end }) {
  if (!fileId || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    throw Object.assign(new Error('bad driveFileId'), { status: 400 });
  }
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (typeof start === 'number' && typeof end === 'number') {
    headers.Range = `bytes=${start}-${end}`;
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
  if (res.status === 404) throw Object.assign(new Error('file not found'), { status: 404 });
  if (!res.ok && res.status !== 206) {
    throw Object.assign(new Error(`Drive download failed: ${res.status}`), { status: 502 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let total = buf.length;
  const cr = res.headers.get('content-range'); // "bytes 0-999/12345"
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) total = parseInt(m[1], 10);
  } else {
    const cl = res.headers.get('content-length');
    if (cl && (typeof start !== 'number')) total = parseInt(cl, 10);
  }
  return { bytes: buf, total };
}

module.exports = { initResumableUpload, downloadBytes };
