#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const { parseOptions } = require("./cli/options.cjs");
const { loadConfig } = require("./config/load-config.cjs");
const { configureTransport } = require("./clients/transport.cjs");
const { createConfluenceClient } = require("./clients/confluence.cjs");
const { createBookstackClient } = require("./clients/bookstack.cjs");
const { exportPages } = require("./workflows/export.cjs");
const { syncPages } = require("./workflows/sync.cjs");
const { importPage } = require("./workflows/import-page.cjs");
const { migrateConfig } = require("./workflows/page-registry.cjs");

async function main() {
  const config = loadConfig(parseOptions());
  configureTransport();
  const confluence = createConfluenceClient({
    base: config.confluenceBase,
    user: config.confluenceUser,
    token: config.confluenceToken,
  });
  const bookstack = config.mode === "export" ? null : createBookstackClient({
    base: config.bookstackBase,
    tokenId: config.bookstackTokenId,
    tokenSecret: config.bookstackTokenSecret,
  }, console.log);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const context = { config, confluence, bookstack, signal: controller.signal };

  try {
    if (config.mode === "migrate") {
      const result = await migrateConfig(context);
      if (result.unresolved.length) process.exitCode = 2;
      return;
    }

    if (config.mode === "import") {
      await importPage(context);
      return;
    }
    const pages = await exportPages(context);
    if (config.mode === "sync") {
      await syncPages(pages, context);
    } else {
      console.log("[info] Dry-run: skip BookStack create");
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message || error}`);
  process.exitCode = error.name === "AbortError" ? 130 : 1;
});
