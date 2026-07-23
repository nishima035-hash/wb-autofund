#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wb-autofund"
cd "${APP_DIR}"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose is not installed"
  exit 1
fi

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
TEMP_FILE="/app/data/manual-backup-${STAMP}.sqlite"
BACKUP_FILE="${APP_DIR}/backups/wb-autofund-${STAMP}.sqlite"

${COMPOSE} exec -T wb-autofund node backup-database.js /app/data/wb-autofund.sqlite "${TEMP_FILE}"
docker cp "wb-autofund:${TEMP_FILE}" "${BACKUP_FILE}"
${COMPOSE} exec -T wb-autofund node --input-type=module -e \
  "import { unlinkSync } from 'node:fs'; try { unlinkSync('${TEMP_FILE}') } catch {}"
test -s "${BACKUP_FILE}"
chmod 600 "${BACKUP_FILE}"

echo "Verified backup: ${BACKUP_FILE}"
