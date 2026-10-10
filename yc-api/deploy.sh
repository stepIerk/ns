#!/bin/bash
# Сборка zip для деплоя Yandex Cloud Function ns-api.
# node_modules в git НЕ коммитится (.gitignore), в zip включается обязательно —
# YC не ставит зависимости сам.
set -e
cd "$(dirname "$0")"

echo "== install deps =="
npm install --omit=dev --no-audit --no-fund

echo "== pack zip =="
rm -f ns-api.zip
zip -qr ns-api.zip index.js package.json lib node_modules -x 'node_modules/.bin/*' 'node_modules/.package-lock.json'
echo "ZIP ready: yc-api/ns-api.zip ($(du -h ns-api.zip | cut -f1))"

echo ""
echo "== deploy (пример) =="
echo "yc serverless function version create \\"
echo "  --function-name ns-api \\"
echo "  --runtime nodejs22 \\"
echo "  --entrypoint index.handler \\"
echo "  --memory 256m --execution-timeout 30s \\"
echo "  --source-path ns-api.zip"
echo ""
echo "Env задать отдельно (консоль или deploy-version.sh из yc-api/env.local):"
echo "  FIREBASE_SERVICE_ACCOUNT_JSON, ALLOWED_UIDS,"
echo "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN,"
echo "  DRIVE_FOLDER_ID(опц.), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, FRONTEND_ORIGINS"
