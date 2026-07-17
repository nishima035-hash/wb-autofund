#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wb-autofund"
cd "${APP_DIR}"

if [[ ! -f .env ]]; then
  echo "Missing ${APP_DIR}/.env"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose is not installed"
  exit 1
fi

${COMPOSE} build --pull
${COMPOSE} up -d --remove-orphans
${COMPOSE} ps
curl --fail --retry 10 --retry-delay 2 http://127.0.0.1:4173/api/health

echo
echo "WB AutoFund deployed."
