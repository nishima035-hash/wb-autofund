#!/usr/bin/env sh
set -eu

git pull --ff-only
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi
${COMPOSE} build --pull
${COMPOSE} up -d --remove-orphans
${COMPOSE} ps
