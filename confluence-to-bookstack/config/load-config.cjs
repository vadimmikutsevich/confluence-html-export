const path = require("node:path");
const {
  parseConfluenceInput,
  deriveConfluenceBaseFromUrl,
} = require("../shared/urls.cjs");
const { loadBookstackConfig } = require("./page-map.cjs");
const { validateConfig } = require("./validate-config.cjs");

function loadConfig(options, env = process.env, cwd = process.cwd()) {
  const { pageId, pageUrl } = options.migrateConfig ? {} : parseConfluenceInput(options.page);
  // Preserve the existing precedence: sync takes priority over dry-run.
  const mode = options.migrateConfig ? "migrate" : options.syncBookstack ? "sync" : options.dryRun ? "export" : "import";
  const configPath = path.resolve(cwd, options.config || "bookstack-config.yml");
  const pageMap = ["sync", "migrate"].includes(mode) ? loadBookstackConfig(configPath) : null;
  let bookstackBase = options.bookstackBase || env.BOOKSTACK_BASE || pageMap?.data.bookstack_base || "";
  if (!bookstackBase && pageMap?.size) {
    bookstackBase = new URL(pageMap.values().next().value).origin;
  }
  const config = {
    ...options,
    mode,
    pageId,
    pageUrl,
    configPath,
    pageMap,
    outDir: path.resolve(cwd, options.outDir || "confluence-export"),
    out: options.out ? path.resolve(cwd, options.out) : null,
    maxDepth: options.maxDepth ?? 1,
    concurrency: options.concurrency ?? 4,
    maxBytes: options.maxBytes ?? 15_000_000,
    fragment: options.fragment !== false,
    confluenceBase: String(
      options.confluenceBase ||
      (pageUrl ? deriveConfluenceBaseFromUrl(pageUrl) : "") ||
      env.CONFLUENCE_BASE || pageMap?.data.confluence_base || "",
    ).replace(/\/+$/, ""),
    confluenceUser: options.confluenceUser || env.CONFLUENCE_USER,
    confluenceToken: options.confluenceToken || env.CONFLUENCE_TOKEN,
    bookstackBase: String(bookstackBase).replace(/\/+$/, ""),
    bookstackTokenId: options.bookstackTokenId || env.BOOKSTACK_TOKEN_ID,
    bookstackTokenSecret: options.bookstackTokenSecret || env.BOOKSTACK_TOKEN_SECRET,
  };
  validateConfig(config);
  return config;
}

module.exports = { loadConfig };
