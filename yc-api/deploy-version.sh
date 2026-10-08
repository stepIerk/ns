#!/bin/bash
# Деплой новой версии кода ns-api (env каждый раз передаём явно,
# иначе версия создастся с пустым окружением).
# Секреты читаются из yc-api/env.local (не в git).
set -e
cd "$(dirname "$0")"

[ -f env.local ] || { echo "Нет yc-api/.env.local — скопируй из .env.local.example и заполни"; exit 1; }
# shellcheck disable=SC1091
set -a; . ./env.local; set +a

[ -f ns-api.zip ] || { echo "Нет ns-api.zip — сначала ./deploy.sh"; exit 1; }

yc serverless function version create \
  --function-name "${YC_FUNCTION:-ns-api}" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 30s \
  --source-path ns-api.zip \
  --environment "FIREBASE_SERVICE_ACCOUNT_JSON=$FIREBASE_SERVICE_ACCOUNT_JSON" \
  --environment "ALLOWED_UIDS=$ALLOWED_UIDS" \
  --environment "GOOGLE_SERVICE_ACCOUNT_JSON=$GOOGLE_SERVICE_ACCOUNT_JSON" \
  --environment "DRIVE_FOLDER_ID=$DRIVE_FOLDER_ID" \
  --environment "VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY" \
  --environment "VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY" \
  --environment "VAPID_SUBJECT=$VAPID_SUBJECT" \
  --environment "FRONTEND_ORIGINS=$FRONTEND_ORIGINS"

echo ""
echo "Готово. URL функции: $(yc serverless function get "${YC_FUNCTION:-ns-api}" --format 'json' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("http_invoke_url",""))')"
