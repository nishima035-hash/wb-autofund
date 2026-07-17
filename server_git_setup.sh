#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/wb-autofund"
REPO_URL="${REPO_URL:-https://github.com/nishima035-hash/wb-autofund.git}"
BRANCH="${BRANCH:-main}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root."
  exit 1
fi

apt-get update
apt-get install -y git docker.io
if ! apt-get install -y docker-compose-plugin; then
  apt-get install -y docker-compose
fi
systemctl enable --now docker

if [[ ! -d "${APP_DIR}/.git" ]]; then
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
git remote set-url origin "${REPO_URL}"
git fetch origin "${BRANCH}"
git checkout -B "${BRANCH}" "origin/${BRANCH}"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created ${APP_DIR}/.env. Fill secrets, then run: bash deploy_server.sh"
  exit 0
fi

bash deploy_server.sh
