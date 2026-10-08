// CORS для фронта на отдельном домене (GitHub Pages).
// FRONTEND_ORIGINS — список через запятую, без слэша в конце.

function configuredOrigins() {
  return (process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Возвращает заголовки для ответа; handled=true — preflight уже отвечен.
function handleCors(method, headers) {
  const origin = (headers.origin || '').replace(/\/+$/, '');
  const allowed = origin !== '' && configuredOrigins().includes(origin);
  const out = {};
  if (allowed) {
    out['Access-Control-Allow-Origin'] = origin;
    out['Vary'] = 'Origin';
  }
  if (method === 'OPTIONS') {
    if (allowed) {
      out['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
      out['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      out['Access-Control-Max-Age'] = '86400';
      return { handled: { statusCode: 204, headers: out, body: '' } };
    }
    return { handled: { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: '{"error":"CORS: origin not allowed"}' } };
  }
  return { headers: out };
}

module.exports = { handleCors };
