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
  const context = { config, confluence, bookstack };

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
}

main().catch((error) => {
  console.error(`[error] ${error.message || error}`);
  process.exitCode = 1;
});
