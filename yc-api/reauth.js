#!/usr/bin/env node
// Полуавтоматическое обновление GOOGLE_OAUTH_REFRESH_TOKEN.
// Фон: OAuth consent screen в тестовом режиме гасит refresh token ~раз в 7 дней,
// после чего загрузка фото падает с "invalid_grant". Этот скрипт сводит
// переавторизацию к одному запуску + одному клику Allow в браузере.
//
// Использование:
//   cd yc-api && npm install  # один раз, нужен пакет googleapis
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node reauth.js
// (значения — из yc-api/env.local или Yandex Console → env функции).
// Скрипт откроет браузер → войди своим Gmail → Allow → свежий refresh token
// появится в терминале. Дальше вставь его в env версии функции
// (Yandex Console → новая версия, либо обнови env.local и запусти ./deploy-version.sh).
//
// Требования: OAuth client типа "Desktop app" (loopback-redirect 127.0.0.1
// разрешён без регистрации). Если client типа Web — добавь в консоли в
// Authorized redirect URIs: http://127.0.0.1:53682/
const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  console.error('Нужно: GOOGLE_OAUTH_CLIENT_ID и GOOGLE_OAUTH_CLIENT_SECRET в окружении.');
  console.error('Пример: GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node reauth.js');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
// prompt: 'consent' — обязательно, иначе Google может НЕ выдать refresh_token повторно.
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [SCOPE],
});

const server = http.createServer(async (req, res) => {
  const done = (code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  try {
    const u = new URL(req.url || '/', REDIRECT_URI);
    if (u.searchParams.get('error')) {
      throw new Error(`Google отказал: ${u.searchParams.get('error')}`);
    }
    const code = u.searchParams.get('code');
    if (!code) {
      done(200, '<h3>Нет code в адресе. Открой ссылку из терминала заново.</h3>');
      return;
    }
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google не выдал refresh_token. Закрой вкладку и запусти скрипт ещё раз.');
    }
    done(200, '<h3>Готово! Новый токен — в терминале. Это окно можно закрыть.</h3>');
    console.log('\n=== Новый GOOGLE_OAUTH_REFRESH_TOKEN ===');
    console.log(tokens.refresh_token);
    console.log('=== Конец ===');
    console.log('Дальше: вставь его в env версии функции (Yandex Console → новая версия),');
    console.log('либо обнови GOOGLE_OAUTH_REFRESH_TOKEN в yc-api/env.local и запусти ./deploy-version.sh');
    server.close(() => process.exit(0));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    done(500, `<h3>Не вышло: ${escapeHtml(msg)}</h3><p>Запусти скрипт заново.</p>`);
    console.error('Обмен code на токен не удался:', msg);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('1. Открываю браузер для входа в Google. Если не открылся — вставь ссылку вручную:');
  console.log(authUrl);
  console.log('2. Войди своим Gmail и нажми Allow/Продолжить.');
  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} "${authUrl}"`, () => {});
});
