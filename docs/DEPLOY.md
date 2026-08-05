# Деплой на локальный сервер (без CI/CD, по ssh)

Стек: `docker compose` — три сервиса: `app` (веб, порт 3000 наружу),
`chrome` (headless для скриншотов), `bot` (telegram).

## Первый запуск

```bash
ssh <сервер>
git clone https://github.com/chappihappymeal/LP-monitor.git lp-monitor
cd lp-monitor
cp .env.example .env && nano .env   # BOT_TOKEN, WALLET
docker compose build
docker compose up -d
```

Веб из локальной сети: `http://<ip-сервера>:3000`.

## Обновление (новая версия)

```bash
ssh <сервер>
cd lp-monitor
git pull
APP_VERSION=v2 docker compose build   # номер версии — вручную, инкрементом
APP_VERSION=v2 docker compose up -d
```

Образы тегируются `lp-monitor-app:<версия>` / `lp-monitor-bot:<версия>` —
откат: `APP_VERSION=v1 docker compose up -d` (пересборка не нужна,
старый образ остаётся локально).

Данные живут вне контейнеров: `./data` (журнал, комментарии, снапшоты
балансов) и volume `cache` (свечи) — обновления их не трогают.
