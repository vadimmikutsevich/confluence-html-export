const { preparePage, finalizePage } = require("./prepare-page.cjs");
const { savePage } = require("../output/files.cjs");

async function exportPages({ config, confluence }) {
  const { pageId, pageUrl } = config;
  let exported = [];
  const visited = new Set();
  const queue = [{ id: String(pageId), depth: 0, pageUrlForThis: pageUrl }];

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    const { id, depth, pageUrlForThis } = item;
    if (visited.has(id)) continue;
    visited.add(id);

    console.log(`[info] Export pageId=${id} depth=${depth}`);
    let res;
    try {
      res = await preparePage({ id, pageUrlForThis }, { config, confluence });
    } catch (e) {
      if (id === String(pageId)) throw e;
      console.warn(
        `[warn] Skip pageId=${id}: ${String(
          e && e.message ? e.message : e,
        )}`,
      );
      continue;
    }
    exported.push(res);

    if (config.recursive && depth < config.maxDepth) {
      for (const linkedId of res.linkedIds) {
        if (!visited.has(linkedId)) {
          queue.push({
            id: linkedId,
            depth: depth + 1,
            pageUrlForThis: null,
          });
        }
      }
    }
  }

  const requiredAnchorsByPageId = new Map();
  for (const res of exported) {
    for (const anchor of res.linkedAnchors || []) {
      if (!requiredAnchorsByPageId.has(anchor.pageId)) {
        requiredAnchorsByPageId.set(anchor.pageId, new Set());
      }
      requiredAnchorsByPageId.get(anchor.pageId).add(anchor.fragment);
    }
  }

  const exportedIds = new Set(exported.map((res) => res.id));
  for (const [targetPageId, fragments] of requiredAnchorsByPageId) {
    if (exportedIds.has(targetPageId)) continue;
    for (const fragment of fragments) {
      console.warn(
        `[warn] Anchor target page was not exported: pageId=${targetPageId} fragment=#${fragment}`,
      );
    }
  }

  exported = exported.map((res) => {
    const requiredAnchors = requiredAnchorsByPageId.get(res.id) || new Set();
    const finalized = finalizePage(res, config, requiredAnchors);

    const outPath = savePage(finalized, config);
    console.log(`[info] Saved HTML: ${outPath}`);
    return finalized;
  });
  return exported;
}

module.exports = { exportPages };
