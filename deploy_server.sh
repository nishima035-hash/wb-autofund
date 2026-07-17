#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wb-autofund"
cd "${APP_DIR}"

if [[ ! -f .env ]]; then
  echo "Missing ${APP_DIR}/.env"
  exit 1
fi

docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
curl --fail --retry 10 --retry-delay 2 http://127.0.0.1:4173/api/health

echo
echo "WB AutoFund deployed."
