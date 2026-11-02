const pLimitImport = require("p-limit");
const pLimit =
  typeof pLimitImport === "function" ? pLimitImport : pLimitImport.default;
const Html = require("../html/pages.cjs");

async function preparePage({ id, pageUrlForThis }, { config, confluence }) {
  const page = await confluence.getFullById(id);
  const ids = Html.collectLinkedPageIds(page.html, confluence.base);
  const limit = pLimit(6);
  const titles = await Promise.all(
    [...ids].map((linkedId) =>
      limit(async () => [linkedId, await confluence.getTitleById(linkedId)]),
    ),
  );
  return Html.preparePage(
    page,
    {
      title: id === config.pageId ? String(config.title || "").trim() : "",
      pageUrl: pageUrlForThis,
      confluenceBase: confluence.base,
    },
    new Map(titles),
  );
}

function finalizePage(prepared, config, requiredAnchors = [], log = console.warn) {
  const page = Html.finalizePage(prepared, config, requiredAnchors);
  for (const fragment of page.unresolvedAnchors) {
    log(`[warn] Anchor target not found: pageId=${page.id} fragment=#${fragment}`);
  }
  return page;
}

module.exports = { preparePage, finalizePage };
