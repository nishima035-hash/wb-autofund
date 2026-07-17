# Развёртывание на Linux через Git

Ниже — вариант с Docker Compose. Он сохраняет SQLite в отдельном Docker-томе и не публикует приложение напрямую в интернет: порт доступен только локальному Nginx.

## 1. Подготовка репозитория

На компьютере:

```bash
git init
git add .
git commit -m "WB AutoFund MVP"
git branch -M main
git remote add origin <URL_ВАШЕГО_РЕПОЗИТОРИЯ>
git push -u origin main
```

Файлы `.env` и `data/` исключены из Git. Не добавляйте в репозиторий токен WB и ключ шифрования.

## 2. Первый запуск на сервере

На Ubuntu/Debian должны быть установлены Git, Docker Engine и Docker Compose Plugin.

Как и в проекте Marketplace Diary, можно запустить подготовленный `server_git_setup.sh`. Он использует отдельную папку `/opt/wb-autofund` и репозиторий `nishima035-hash/wb-autofund`, поэтому дневник не затрагивается.

```bash
git clone <URL_ВАШЕГО_РЕПОЗИТОРИЯ> /opt/wb-autofund
cd /opt/wb-autofund
cp .env.example .env
openssl rand -hex 32
```

Скопируйте результат последней команды в `APP_ENCRYPTION_KEY` файла `.env`. Также задайте уникальные `ADMIN_USERNAME` и `ADMIN_PASSWORD` (не менее 12 символов). Браузер запросит их при открытии панели. Для первого запуска оставьте:

```dotenv
NODE_ENV=production
WB_LIVE_DEPOSITS=false
```

Запустите:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4173/api/health
```

Ожидаемый ответ проверки: `{"status":"ok",...}`.

## 3. Домен и HTTPS

Возьмите `deploy/nginx.conf.example`, замените `autofund.example.ru` своим доменом и установите конфигурацию в Nginx. После проверки Nginx выпустите TLS-сертификат через Certbot. Не открывайте порт 4173 в firewall: в `compose.yaml` он привязан только к `127.0.0.1`.

## 4. Подключение WB

Откройте сайт по HTTPS, сохраните токен категории «Продвижение» и сначала проверьте синхронизацию в демо-режиме. Настоящее пополнение начнёт работать только когда одновременно:

1. в интерфейсе выключен демо-режим;
2. в `.env` установлено `WB_LIVE_DEPOSITS=true`;
3. контейнер перезапущен: `docker compose up -d`.

## 5. Обновление из Git

```bash
cd /opt/wb-autofund
sh deploy/update.sh
```

Скрипт принимает только fast-forward обновления, пересобирает образ и сохраняет базу в томе `wb_autofund_data`.

## Резервная копия SQLite

Перед крупным обновлением остановите запись и скопируйте базу из тома:

```bash
docker compose stop wb-autofund
docker run --rm -v wb_autofund_data:/data -v "$PWD":/backup alpine cp /data/wb-autofund.sqlite /backup/wb-autofund-backup.sqlite
docker compose start wb-autofund
```

Файл резервной копии содержит рабочие данные и зашифрованный токен. Храните его вместе с `APP_ENCRYPTION_KEY` в защищённом месте, но отдельно друг от друга.
