# Confluence → BookStack (CLI)

CLI утилита для выгрузки страниц Confluence в HTML и (опционально) импорта в BookStack:

- Забирает HTML страницы из Confluence через `body.export_view` (экспортный HTML).
- При импорте в BookStack скачивает картинки, загружает их в BookStack image gallery и подставляет BookStack URL в HTML.
- Умеет **сохранять файл по title** и **рекурсивно выгружать связанные страницы** (по ссылкам `/pages/<id>`).

## Структура кода

Точка входа `cli.cjs` загружает настройки, создаёт API-клиенты и запускает нужный сценарий.

```text
cli/options.cjs          — объявления CLI-флагов
config/                 — загрузка настроек, проверка параметров, карта страниц
clients/                — HTTP, авторизация, Confluence и BookStack API
workflows/              — экспорт, синхронизация, импорт страницы, перенос изображений
html/                   — преобразование HTML, ссылок, якорей и изображений
output/                 — имена файлов и сохранение HTML
shared/                 — общие функции для URL и метаданных изображений
```

Сетевые запросы выполняются только внутри `clients/`. HTML-функции получают готовые
данные; загрузку заголовков страниц координирует `workflows/prepare-page.cjs`.
Список страниц BookStack кэшируется в клиенте на время запуска для поиска по URL.

Настройки собираются и проверяются до начала экспорта. Флаги имеют приоритет над
переменными окружения; базовый URL Confluence также может выводиться из `--page`,
а BookStack — из карты страниц при синхронизации. `BOOKSTACK_BASE` поддерживается
как при синхронизации, так и при создании страницы. `--max-depth 0` означает экспорт
только исходной страницы. Нулевой или отрицательный `--concurrency` и отрицательные лимиты
отклоняются до выполнения запросов.

Карта `bookstack-config.yml` остаётся в корне проекта, результаты — в каталоге
`--out-dir`. Имена CLI-флагов и команда `npm run c2b` сохранены.

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
  --sync-bookstack ^
  --config bookstack-config.yml
```

Требуется `bookstack-config.yml` с картой `page name -> link`. Страницы из Confluence сопоставляются по заголовку; ссылки на другие Confluence-страницы заменяются на BookStack-ссылки из конфига.

Ссылки на конкретные блоки (`page URL#anchor`) обрабатываются в два прохода: сначала CLI собирает входящие якорные ссылки, затем сохраняет соответствующие `id` на целевых страницах. Чтобы целевая страница также участвовала в обработке, используйте `--recursive` с достаточным `--max-depth`. Для ненайденных якорей CLI выводит предупреждение.

## Параметры

- `--page`: URL Confluence или pageId.
- `--confluence-base`: база Confluence (если `--page` это pageId).
- `--confluence-user`, `--confluence-token`: можно не указывать, если заданы `CONFLUENCE_USER/CONFLUENCE_TOKEN`.
- `--dry-run`: только выгрузка в HTML (без BookStack).
- `--out`: сохранить в конкретный файл.
- `--out-dir`: папка, куда сохранять HTML в `--dry-run` режиме (по умолчанию `confluence-export`).
- `--recursive`: дополнительно выгружать страницы Confluence, на которые есть ссылки.
- `--max-depth`: глубина рекурсии.
- `--concurrency`: параллельные скачивания картинок (по умолчанию 4).
- `--max-bytes`: лимит размера одной картинки (по умолчанию 15MB).
- `--keep-ids`: не удалять `id` атрибуты при чистке HTML.
- `--config`: путь к `bookstack-config.yml` (карта page name → link).
- `--sync-bookstack`: экспорт + обновление страниц в BookStack по конфигу, замена ссылок Confluence → BookStack.
