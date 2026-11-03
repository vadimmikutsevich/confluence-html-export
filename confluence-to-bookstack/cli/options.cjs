const { Command } = require("commander");

function parseOptions(argv = process.argv) {
  const program = new Command();
  program
    .name("confluence-to-bookstack")
    .description(
      "CLI: выгрузка страниц Confluence в HTML (и импорт в BookStack)",
    )
    .option("--page <urlOrId>", "URL страницы Confluence или pageId (обязательно, кроме --migrate-config)")
    .option("--migrate-config", "Проверить карту страниц и заполнить постоянные ID; BookStack не изменяется")
    .option(
      "--confluence-base <url>",
      "База Confluence, напр. https://site.atlassian.net/wiki",
    )
    .option(
      "--confluence-user <email>",
      "Confluence user/email (или env CONFLUENCE_USER)",
    )
    .option(
      "--confluence-token <token>",
      "Confluence API token (или env CONFLUENCE_TOKEN)",
    )
    .option(
      "--bookstack-base <url>",
      "База BookStack, напр. https://book.example.com",
    )
    .option(
      "--bookstack-token-id <id>",
      "BookStack token id (или env BOOKSTACK_TOKEN_ID)",
    )
    .option(
      "--bookstack-token-secret <secret>",
      "BookStack token secret (или env BOOKSTACK_TOKEN_SECRET)",
    )
    .option(
      "--book-id <id>",
      "BookStack book_id (если страница без главы)",
      (v) => (v ? Number(v) : v),
    )
    .option("--chapter-id <id>", "BookStack chapter_id", (v) =>
      v ? Number(v) : v,
    )
    .option(
      "--book-name <name>",
      "BookStack book name (будет найден/создан, если не указан book-id/chapter-id)",
    )
    .option("--title <name>", "Переопределить заголовок страницы в BookStack")
    .option(
      "--dry-run",
      "Без записи в BookStack и конфиг; с --sync-bookstack проверить план синхронизации",
    )
    .option(
      "--out <file>",
      "Куда сохранить итоговый HTML (для dry-run или отладки)",
    )
    .option(
      "--out-dir <dir>",
      "Папка для сохранения HTML (default: ./confluence-export)",
      "confluence-export",
    )
    .option(
      "--recursive",
      "Рекурсивно выгружать Confluence-страницы, на которые есть ссылки",
    )
    .option(
      "--max-depth <n>",
      "Глубина рекурсии (default: 1)",
      (v) => Number(v),
      1,
    )
    .option(
      "--concurrency <n>",
      "Параллельные скачивания картинок (default: 4)",
      (v) => Number(v),
      4,
    )
    .option(
      "--max-bytes <n>",
      "Макс размер одной картинки в байтах (default: 15000000)",
      (v) => Number(v),
      15_000_000,
    )
    .option("--keep-ids", "Сохранить id атрибуты (по умолчанию удаляются)")
    .option(
      "--no-fragment",
      "Сохранять полный HTML (иначе сохраняется только фрагмент body)",
    )
    .option(
      "--config <path>",
      "Путь к bookstack-config.yml (карта Confluence ID → BookStack ID)",
    )
    .option(
      "--sync-bookstack",
      "Экспорт + обновление страниц в BookStack по конфигу (замена ссылок Confluence на BookStack)",
    )
    .parse(argv);

  const options = program.opts();
  if (!options.page && !options.migrateConfig) program.error("Нужно указать --page или --migrate-config");
  if (options.migrateConfig && options.syncBookstack) program.error("--migrate-config и --sync-bookstack нельзя совмещать");
  return options;
}

module.exports = { parseOptions };
