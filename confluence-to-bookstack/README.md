# Confluence → BookStack (CLI)

CLI утилита для выгрузки страниц Confluence в HTML и (опционально) импорта в BookStack:

- Забирает HTML страницы из Confluence через `body.export_view` (экспортный HTML).
- Опционально **встраивает картинки в HTML как `data:` (base64)**.
  BookStack при создании страницы умеет “вытаскивать” base64-картинки и сохранять их как gallery images (см. API docs BookStack: [Pages → create](https://demo.bookstackapp.com/api/docs#pages-create)).
- Умеет **сохранять файл по title** и **рекурсивно выгружать связанные страницы** (по ссылкам `/pages/<id>`).

## Установка

Из корня проекта:

```bash
npm i
```

## Быстрый старт

### 1) Переменные окружения

PowerShell:

```powershell
$env:CONFLUENCE_USER="you@company.com"
$env:CONFLUENCE_TOKEN="CONFLUENCE_API_TOKEN"

$env:BOOKSTACK_TOKEN_ID="BOOKSTACK_TOKEN_ID"
$env:BOOKSTACK_TOKEN_SECRET="BOOKSTACK_TOKEN_SECRET"
```

Альтернатива: положить секреты в локальный `.env` (файл игнорируется):

- Скопируйте `.env.example` → `.env`
- Заполните значения

Если вы будете передавать **только** pageId (число), то ещё нужно:

```powershell
$env:CONFLUENCE_BASE="https://gambchamp.atlassian.net/wiki"
```

### 2) Запуск

Выгрузить HTML-фрагмент в файл (имя по title, папка `confluence-export` по умолчанию):

```bash
npm run c2b -- ^
  --page "https://gambchamp.atlassian.net/wiki/spaces/BP/pages/178684038" ^
  --dry-run
```

Выгрузить в конкретный файл:

```bash
npm run c2b -- ^
  --page "https://gambchamp.atlassian.net/wiki/spaces/BP/pages/178684038" ^
  --dry-run ^
  --out ".\\out.html"
```

Рекурсивная выгрузка связанных Confluence-страниц (1 уровень ссылок):

```bash
npm run c2b -- ^
  --page "https://gambchamp.atlassian.net/wiki/spaces/BP/pages/178684038" ^
  --dry-run ^
  --recursive ^
  --max-depth 1
```

**Синхронизация с BookStack** (экспорт + обновление страниц по конфигу + замена ссылок):

```bash
npm run c2b -- ^
  --page "https://gambchamp.atlassian.net/wiki/spaces/BP/pages/197230594/-+." ^
  --recursive ^
  --max-depth 10 ^
  --no-inline-images ^
  --sync-bookstack ^
  --config bookstack-config.yml
```

Требуется `bookstack-config.yml` с картой `page name -> link`. Страницы из Confluence сопоставляются по заголовку; ссылки на другие Confluence-страницы заменяются на BookStack-ссылки из конфига.

## Параметры

- `--page`: URL Confluence или pageId.
- `--confluence-base`: база Confluence (если `--page` это pageId).
- `--confluence-user`, `--confluence-token`: можно не указывать, если заданы `CONFLUENCE_USER/CONFLUENCE_TOKEN`.
- `--dry-run`: только выгрузка в HTML (без BookStack).
- `--out`: сохранить в конкретный файл.
- `--out-dir`: папка, куда сохранять HTML в `--dry-run` режиме (по умолчанию `confluence-export`).
- `--recursive`: дополнительно выгружать страницы Confluence, на которые есть ссылки.
- `--max-depth`: глубина рекурсии.
- `--no-inline-images`: не встраивать картинки (оставить ссылки).
- `--concurrency`: параллельные скачивания картинок (по умолчанию 4).
- `--max-bytes`: лимит размера одной картинки (по умолчанию 15MB).
- `--keep-ids`: не удалять `id` атрибуты при чистке HTML.
- `--config`: путь к `bookstack-config.yml` (карта page name → link).
- `--sync-bookstack`: экспорт + обновление страниц в BookStack по конфигу, замена ссылок Confluence → BookStack.

