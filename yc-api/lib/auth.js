// Проверка Firebase ID token + allowlist из двух UID.
const { allowedUids, verifyIdToken } = require('./firestore');

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === lower) return String(headers[k] || '');
  }
  return '';
}

async function requireUid(headers) {
  // Firebase ID token едет в X-Firebase-Token: invoke-endpoint Яндекса
  // перехватывает Authorization: Bearer как свой IAM-токен и режет 403
  // до функции. Authorization оставлен как fallback для локальных тестов.
  let token = getHeader(headers, 'x-firebase-token');
  if (token.startsWith('Bearer ')) token = token.slice(7);
  if (!token) {
    const h = getHeader(headers, 'authorization');
    token = h.startsWith('Bearer ') ? h.slice(7) : '';
  }
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 });
  const decoded = await verifyIdToken(token);
  const allow = allowedUids();
  if (allow.length > 0 && !allow.includes(decoded.sub)) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return decoded.sub;
}

module.exports = { requireUid };
