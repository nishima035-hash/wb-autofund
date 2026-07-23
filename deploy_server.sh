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
${COMPOSE} run --rm --no-deps wb-autofund node validate-config.js
chmod 600 .env

BACKUP_DIR="${APP_DIR}/backups"
mkdir -p "${BACKUP_DIR}"
if ${COMPOSE} ps -q wb-autofund >/dev/null 2>&1 && [[ -n "$(${COMPOSE} ps -q wb-autofund)" ]]; then
  BACKUP_FILE="${BACKUP_DIR}/wb-autofund-$(date +%Y%m%d-%H%M%S).sqlite"
  if ${COMPOSE} exec -T wb-autofund test -f /app/backup-database.js; then
    ${COMPOSE} exec -T wb-autofund node backup-database.js \
      /app/data/wb-autofund.sqlite /app/data/predeploy-backup.sqlite
  else
    ${COMPOSE} exec -T wb-autofund node --input-type=module -e \
      "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/app/data/wb-autofund.sqlite'); db.exec(\"PRAGMA wal_checkpoint(FULL); VACUUM INTO '/app/data/predeploy-backup.sqlite'\"); db.close()"
  fi
  docker cp wb-autofund:/app/data/predeploy-backup.sqlite "${BACKUP_FILE}"
  ${COMPOSE} exec -T wb-autofund node --input-type=module -e \
    "import { unlinkSync } from 'node:fs'; try { unlinkSync('/app/data/predeploy-backup.sqlite') } catch {}"
  chmod 600 "${BACKUP_FILE}"
  echo "Database backup: ${BACKUP_FILE}"
fi

${COMPOSE} up -d --remove-orphans
${COMPOSE} ps
curl --fail --retry 10 --retry-delay 2 http://127.0.0.1:4173/api/health

echo
echo "WB AutoFund deployed."
