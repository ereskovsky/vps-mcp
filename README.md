# vps-mcp

MCP-сервер для управления VPS-серверами через SSH. Даёт AI-ассистенту полный контроль над зарегистрированными серверами: выполнение команд, передача файлов, управление Docker, деплой приложений и автоматическое ведение документации.

## Содержание

- [Как это работает](#как-это-работает)
- [Установка](#установка)
- [Использование локально (stdio)](#использование-локально-stdio)
- [Деплой на VPS (HTTP)](#деплой-на-vps-http)
- [Подключение к Claude.ai (web, OAuth)](#подключение-к-claudeai-web-oauth)
- [Добавление сервера в vault](#добавление-сервера-в-vault)
- [Инструменты](#инструменты)
- [Типичные сценарии](#типичные-сценарии)
- [Безопасность](#безопасность)
- [Структура данных](#структура-данных)

---

## Как это работает

```
Claude Code / Claude Desktop / Dispatch
            │
            │  MCP protocol
            ▼
      vps-mcp (этот сервер)
            │
            │  SSH / SFTP
            ▼
     Ваши VPS-серверы
```

vps-mcp хранит SSH-ключи и пароли в **зашифрованном vault** (AES-256-GCM). При вызове любого инструмента сервер открывает SSH-соединение с нужным VPS, выполняет действие и возвращает результат.

Поддерживает два режима транспорта:
- **stdio** — для локального использования (Claude Code, Claude Desktop на том же компьютере)
- **HTTP (Streamable HTTP)** — для удалённого доступа (другие устройства, Dispatch, claude.ai)

---

## Установка

**Требования:** Node.js 20+

```bash
git clone <repo>
cd vps-mcp
npm install
npm run build
```

Создайте `.env` из шаблона:

```bash
cp .env.example .env
```

Отредактируйте `.env`:

```env
# Мастер-пароль для шифрования vault. Придумайте любой — это не внешний сервис.
VAULT_PASSWORD=придумайте-сложный-пароль

# Bearer-токен для HTTP-режима (сгенерируйте случайную строку)
API_KEY=сгенерируйте-через-openssl-rand-hex-32

# Порт HTTP-сервера (по умолчанию 3001)
# PORT=3001

# Для HTTP-режима с OAuth (нужно при подключении через Claude.ai web)
BASE_URL=https://vps-mcp.yourdomain.com   # без порта — иначе OAuth metadata недоступен снаружи
CLIENT_ID=vps-mcp                          # любая строка, будет нужна при подключении в Claude.ai
CLIENT_SECRET=                             # по умолчанию равен API_KEY, можно задать отдельно
```

---

## Использование локально (stdio)

Этот режим работает **без деплоя** — MCP-сервер запускается на вашем компьютере и подключается к VPS по SSH.

### Claude Code

```bash
claude mcp add vps-mcp -s user -e VAULT_PASSWORD="ваш-пароль" -- node "/путь/к/vps-mcp/dist/index.js" --stdio
```

### Claude Desktop

Добавьте в `claude_desktop_config.json` (`~/Library/Application Support/Claude/` на Mac, `%APPDATA%\Claude\` на Windows):

```json
{
  "mcpServers": {
    "vps-mcp": {
      "command": "node",
      "args": ["/абсолютный/путь/к/vps-mcp/dist/index.js", "--stdio"],
      "env": {
        "VAULT_PASSWORD": "ваш-пароль"
      }
    }
  }
}
```

---

## Деплой на VPS (HTTP)

Нужен для доступа с других устройств, из браузера или через Dispatch.

### 1. Подготовка

Скопируйте проект на VPS (или сделайте `git clone`). В `Caddyfile` замените домен:

```
vps-mcp.yourdomain.com {
    reverse_proxy vps-mcp:3001
}
```

Убедитесь, что DNS A-запись домена указывает на IP этого VPS.

### 2. Запуск

```bash
# На VPS
cp .env.example .env
# Заполните VAULT_PASSWORD и API_KEY

docker compose up -d
```

Caddy автоматически получит TLS-сертификат через Let's Encrypt.

### 3. Подключение клиентов

Claude Code / Claude Desktop (удалённо):

```bash
claude mcp add vps-mcp -s user --transport http "https://vps-mcp.yourdomain.com/mcp" \
  --header "Authorization: Bearer ваш-api-key"
```

Или вручную в конфиге:

```json
{
  "mcpServers": {
    "vps-mcp": {
      "url": "https://vps-mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ваш-api-key"
      }
    }
  }
}
```

---

## Подключение к Claude.ai (web, OAuth)

Claude.ai использует OAuth 2.0 (`authorization_code` + PKCE) для подключения к удалённым MCP-серверам. vps-mcp реализует полный OAuth flow.

### Требования

- Сервер задеплоен и доступен по HTTPS
- `BASE_URL` в `.env` указывает на публичный домен **без нестандартного порта** (например `https://vps-mcp.yourdomain.com`, не `https://...:4443`) — иначе Claude.ai не сможет получить `token_endpoint` из OAuth metadata

### Как подключить

1. Откройте **Claude.ai → Settings → Integrations → Add integration**
2. Введите URL: `https://vps-mcp.yourdomain.com/mcp`
3. Введите **Client ID** (значение `CLIENT_ID` из `.env`)
4. Введите **Client Secret** (значение `CLIENT_SECRET` из `.env`, по умолчанию равно `API_KEY`)
5. Claude.ai откроет страницу авторизации, подтвердите доступ

### OAuth endpoints

| Endpoint | Описание |
|----------|----------|
| `GET /.well-known/oauth-authorization-server` | OAuth metadata (discovery) |
| `GET /oauth/authorize` | Страница авторизации (редирект в браузере) |
| `POST /oauth/token` | Обмен кода на токен |

---

## Добавление сервера в vault

### Через SSH-ключ (рекомендуется)

Сначала закодируйте ваш приватный ключ в base64:

```bash
# Linux / Mac
base64 -w 0 ~/.ssh/id_ed25519

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.ssh\id_ed25519"))
```

Затем вызовите инструмент `add_server`:

```
name: prod-1
host: 1.2.3.4
port: 22
username: root
authType: key
privateKey: <base64-строка из команды выше>
passphrase: <пассфраза ключа, если есть>
description: Основной продакшн сервер, nginx + 3 docker-контейнера
```

### Через пароль

```
name: staging
host: 5.6.7.8
port: 22
username: ubuntu
authType: password
password: ваш-ssh-пароль
description: Стейджинг окружение
```

---

## Инструменты

### Registry — управление серверами

#### `list_servers`
Возвращает список всех зарегистрированных серверов. Пароли и ключи **не показываются**.

```
→ Вызов: list_servers (без параметров)
← Результат: [{ name, host, port, username, authType, description }]
```

#### `add_server`
Добавляет новый сервер в зашифрованный vault.

| Параметр | Тип | Обязательный | Описание |
|---|---|---|---|
| `name` | string | да | Уникальный идентификатор (латиница, цифры, `-_`) |
| `host` | string | да | IP-адрес или hostname |
| `port` | number | нет | SSH-порт (по умолчанию 22) |
| `username` | string | да | SSH-пользователь |
| `authType` | `key` / `password` | да | Тип аутентификации |
| `privateKey` | string | если `key` | Base64-encoded PEM приватный ключ |
| `passphrase` | string | нет | Пассфраза ключа |
| `password` | string | если `password` | SSH-пароль |
| `description` | string | нет | Описание сервера |

#### `remove_server`
Удаляет сервер из vault.

| Параметр | Тип | Описание |
|---|---|---|
| `name` | string | Имя сервера для удаления |

---

### SSH — выполнение команд

#### `execute_command`
Выполняет одну команду на сервере через SSH.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера из vault |
| `command` | string | Shell-команда |

```
→ execute_command(server="prod-1", command="df -h")
← { stdout: "...", stderr: "", exitCode: 0 }
```

#### `execute_script`
Выполняет многострочный bash-скрипт.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `script` | string | Bash-скрипт (многострочный) |

```
→ execute_script(server="prod-1", script="
    cd /app
    git log --oneline -5
    systemctl status nginx
  ")
```

---

### Files — передача файлов (SFTP)

#### `upload_file`
Загружает локальный файл на сервер.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `localPath` | string | Абсолютный путь к локальному файлу |
| `remotePath` | string | Абсолютный путь назначения на сервере |

#### `download_file`
Скачивает файл с сервера.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `remotePath` | string | Путь к файлу на сервере |
| `localPath` | string | Локальный путь для сохранения |

#### `list_remote_files`
Выводит содержимое директории на сервере.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `remotePath` | string | Путь к директории |

```
← [{ name, type, size, modifiedAt, permissions }]
```

---

### Docker & Deploy

#### `docker_ps`
Выводит список Docker-контейнеров.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `all` | boolean | Включать остановленные (по умолчанию: true) |

#### `docker_compose`
Запускает команду `docker compose` в указанной директории.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `path` | string | Абсолютный путь к директории с `docker-compose.yml` |
| `action` | enum | `up` / `down` / `restart` / `pull` / `logs` / `ps` / `build` |
| `service` | string | (опционально) Имя конкретного сервиса |
| `flags` | string | (опционально) Дополнительные флаги |

```
→ docker_compose(server="prod-1", path="/app/my-project", action="logs", service="api", flags="--tail=100")
```

#### `docker_exec`
Выполняет команду внутри запущенного контейнера.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `container` | string | Имя или ID контейнера |
| `command` | string | Команда для выполнения |

```
→ docker_exec(server="prod-1", container="my-app", command="python manage.py migrate")
```

#### `deploy_app`
Деплоит приложение: git pull → build → restart.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `path` | string | Путь к директории приложения |
| `branch` | string | Git-ветка (по умолчанию: `main`) |
| `buildCommand` | string | (опционально) Команда сборки |
| `restartCommand` | string | (опционально) Команда перезапуска |

```
→ deploy_app(
    server="prod-1",
    path="/app/my-project",
    branch="main",
    buildCommand="npm run build",
    restartCommand="docker compose up -d"
  )
← { success: true, steps: [{ step: "git pull", result: {...} }, ...] }
```

---

### Docs — документация серверов

#### `scan_server`
Сканирует сервер и возвращает полный снимок состояния:
- OS и версия ядра
- CPU и оперативная память
- Использование дискового пространства
- Uptime
- Запущенные Docker-контейнеры и образы
- Запущенные systemd-сервисы
- Открытые порты (ss / netstat)
- Cron-задачи

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |

#### `get_server_docs`
Читает существующую Markdown-документацию сервера из `data/docs/{server}.md`.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |

#### `update_server_docs`
Записывает или заменяет Markdown-документацию сервера.

| Параметр | Тип | Описание |
|---|---|---|
| `server` | string | Имя сервера |
| `content` | string | Полное содержимое Markdown-файла |

---

## Типичные сценарии

### Первичное подключение нового сервера

```
1. add_server        — зарегистрировать сервер
2. execute_command   — проверить подключение: "uptime"
3. scan_server       — собрать снимок состояния
4. update_server_docs — сохранить документацию
```

### Деплой приложения

```
1. deploy_app        — git pull + build + restart
2. docker_ps         — проверить статус контейнеров
3. docker_compose    — посмотреть логи: action="logs"
```

### Отладка проблемы на сервере

```
1. execute_command   — "journalctl -u nginx --since '10 minutes ago'"
2. docker_compose    — action="logs", flags="--tail=200"
3. execute_command   — "df -h && free -h"
```

### Обновление документации после изменений

```
1. scan_server       — получить актуальное состояние
2. get_server_docs   — прочитать существующую документацию
   (AI объединяет результаты)
3. update_server_docs — сохранить обновлённую документацию
```

### Перенос конфига между серверами

```
1. download_file     — скачать конфиг с source-сервера
2. upload_file       — загрузить на target-сервер
3. execute_command   — перезапустить сервис
```

---

## Безопасность

- **Vault** (`data/servers.enc.json`) зашифрован AES-256-GCM, ключ derivируется через PBKDF2 (100 000 итераций) из `VAULT_PASSWORD`
- SSH-ключи и пароли **никогда не передаются в открытом виде** — только через зашифрованный vault
- Файл vault и директория `data/` добавлены в `.gitignore` — не попадают в репозиторий
- HTTP-режим защищён Bearer-токеном (`API_KEY`) на каждый запрос
- При подключении через Claude.ai используется OAuth 2.0 (`authorization_code` + PKCE) — прямой доступ к API без передачи `API_KEY` на клиент
- HTTPS обрабатывается Caddy (автоматический TLS через Let's Encrypt)
- В `list_servers` и логах ключи/пароли **не отображаются**

---

## Структура данных

```
vps-mcp/
├── src/                        # Исходный код TypeScript
│   ├── index.ts                # Точка входа, определение транспорта
│   ├── server.ts               # McpServer и регистрация инструментов
│   ├── types.ts                # Общие типы
│   ├── lib/
│   │   ├── credential-store.ts # Шифрование/дешифрование vault
│   │   ├── ssh-client.ts       # SSH/SFTP клиент (обёртка над ssh2)
│   │   └── doc-manager.ts      # Чтение/запись Markdown-документации
│   └── tools/                  # Реализация MCP-инструментов
│       ├── registry.ts
│       ├── ssh.ts
│       ├── files.ts
│       ├── deploy.ts
│       └── docs.ts
├── dist/                       # Скомпилированный JS (генерируется npm run build)
├── data/
│   ├── servers.enc.json        # Зашифрованный vault (создаётся автоматически)
│   └── docs/
│       └── {server-name}.md    # Документация по каждому серверу
├── docker-compose.yml          # Для деплоя: vps-mcp + Caddy
├── Dockerfile
├── Caddyfile                   # Конфиг reverse proxy
└── .env.example                # Шаблон переменных окружения
```
