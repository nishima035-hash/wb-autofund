#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root."
  exit 1
fi

apt-get update
apt-get install -y nginx

cat > /etc/nginx/sites-available/wb-autofund <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name _;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/wb-autofund /etc/nginx/sites-enabled/wb-autofund
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

curl --fail http://127.0.0.1:4173/api/health
echo
echo "Open: http://$(hostname -I | awk '{print $1}')"
