const path = require("node:path");
const fs = require("node:fs");
const yaml = require("js-yaml");
const { loadConfig } = require("../../config/load-config.cjs");
const { parseConfluenceInput, deriveConfluenceBaseFromUrl } = require("../../shared/urls.cjs");
const { createConfluenceClient } = require("../../clients/confluence.cjs");
const { createBookstackClient } = require("../../clients/bookstack.cjs");

const projectRoot = path.resolve(__dirname, "../../..");
const inputSchema = {
  type: "object", additionalProperties: false,
  required: ["documents", "mode"],
  properties: {
    documents: { type: "string", minLength: 1 },
    mode: { enum: ["export", "sync", "import"] },
    recursive: { type: "boolean", default: false },
    maxDepth: { type: "integer", minimum: 0, default: 1 },
    concurrency: { type: "integer", minimum: 1, default: 4 },
    maxBytesMb: { type: "integer", minimum: 0, default: 15 },
    keepIds: { type: "boolean", default: false },
    fullHtml: { type: "boolean", default: false },
    bookId: { type: "integer", minimum: 1 },
    chapterId: { type: "integer", minimum: 1 },
    bookName: { type: "string" },
  },
};

function bookstackSettings(env, configPath = path.join(projectRoot, "bookstack-config.yml")) {
  let base = env.BOOKSTACK_BASE || "";
  if (!base) {
    try {
      // Connection settings must not depend on page-map validation. Invalid IDs
      // are reported by loadConfig during sync checks, not as missing tokens.
      const data = yaml.load(fs.readFileSync(configPath, "utf8"));
      base = data?.bookstack_base || "";
      if (!base && Array.isArray(data?.books)) {
        const link = data.books.flatMap(book => Array.isArray(book?.pages) ? book.pages : [])
          .find(page => page?.link)?.link;
        if (link) base = new URL(link).origin;
      }
    } catch { /* Report missing settings when checking a task. */ }
  }
  return { base: base.replace(/\/+$/, ""), tokenId: env.BOOKSTACK_TOKEN_ID, tokenSecret: env.BOOKSTACK_TOKEN_SECRET };
}

function publicSettings(env) {
  const bs = bookstackSettings(env);
  return {
    confluenceBase: env.CONFLUENCE_BASE || "",
    bookstackBase: bs.base,
    confluenceReady: Boolean(env.CONFLUENCE_USER && env.CONFLUENCE_TOKEN),
    bookstackReady: Boolean(bs.base && bs.tokenId && bs.tokenSecret),
  };
}

function prepareInput(input, env) {
  const lines = input.documents.split(/\r?\n/);
  const roots = [];
  const seen = new Set();
  let confluenceBase = env.CONFLUENCE_BASE;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = parseConfluenceInput(line.trim());
      if (parsed.pageUrl) {
        const url = new URL(parsed.pageUrl);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Нужна HTTP(S)-ссылка без логина и пароля");
        confluenceBase ||= deriveConfluenceBaseFromUrl(parsed.pageUrl);
        if (deriveConfluenceBaseFromUrl(parsed.pageUrl) !== confluenceBase.replace(/\/+$/, "")) {
          throw new Error("Документы должны относиться к одному настроенному Confluence");
        }
      }
    } catch (error) {
      throw new Error(`Строка ${index + 1}: ${error.message}`);
    }
    if (!seen.has(parsed.pageId)) {
      seen.add(parsed.pageId);
      roots.push({ id: parsed.pageId, pageUrl: parsed.pageUrl });
    }
  }
  if (!roots.length) throw new Error("Добавьте хотя бы один документ");
  if (input.mode === "import" && input.recursive) throw new Error("Создание страниц не поддерживает рекурсивный обход. Используйте синхронизацию.");
  if (input.mode === "import" && !input.bookId && !input.chapterId && !input.bookName?.trim()) {
    throw new Error("Выберите книгу, главу или укажите имя новой книги");
  }
  const config = loadConfig({
    page: roots[0].id, confluenceBase,
    dryRun: input.mode === "export", syncBookstack: input.mode === "sync",
    recursive: input.recursive, maxDepth: input.maxDepth,
    concurrency: input.concurrency, maxBytes: (input.maxBytesMb ?? 15) * 1_000_000,
    keepIds: input.keepIds, fragment: !input.fullHtml,
    bookId: input.bookId, chapterId: input.chapterId, bookName: input.bookName?.trim(),
    bookstackBase: bookstackSettings(env).base,
  }, env, projectRoot);
  const confluence = createConfluenceClient({ base: config.confluenceBase, user: config.confluenceUser, token: config.confluenceToken });
  const bookstack = input.mode === "export" ? null : createBookstackClient({
    base: config.bookstackBase, tokenId: config.bookstackTokenId, tokenSecret: config.bookstackTokenSecret,
  });
  return { config, confluence, bookstack, roots };
}

module.exports = { inputSchema, prepareInput, publicSettings, bookstackSettings, projectRoot };
