const { preparePage, finalizePage } = require("./prepare-page.cjs");
const { savePage } = require("../output/files.cjs");
const { checkpoint } = require("./progress.cjs");

async function exportPages({ config, confluence, roots, signal, onEvent = () => {}, log = console.log }) {
  const { pageId, pageUrl } = config;
  let exported = [];
  const visited = new Set();
  const seeds = roots || [{ id: String(pageId), pageUrl }];
  const rootIds = new Set(seeds.map((root) => root.id));
  const queue = seeds.map((root) => ({ id: root.id, depth: 0, pageUrlForThis: root.pageUrl }));
  const discovered = new Set(rootIds);
  onEvent({ type: "phase", phase: "export", total: null });

  while (queue.length) {
    checkpoint(signal);
    const item = queue.shift();
    if (!item) break;
    const { id, depth, pageUrlForThis } = item;
    if (visited.has(id)) continue;
    visited.add(id);

    log(`[info] Export pageId=${id} depth=${depth}`);
    onEvent({ type: "page.started", id, phase: "export", discovered: discovered.size });
    let res;
    try {
      res = await preparePage({ id, pageUrlForThis }, { config, confluence });
    } catch (e) {
      if (rootIds.has(id)) throw e;
      onEvent({ type: "page.failed", id, phase: "export" });
      log(
        `[warn] Skip pageId=${id}: ${String(
          e && e.message ? e.message : e,
        )}`,
      );
      continue;
    }
    exported.push(res);
    onEvent({ type: "page.loaded", id, title: res.title, loaded: exported.length });

    if (config.recursive && depth < Number(config.maxDepth || 1)) {
      for (const linkedId of res.linkedIds) {
        if (!visited.has(linkedId)) {
          if (discovered.has(linkedId)) continue;
          discovered.add(linkedId);
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
      log(
        `[warn] Anchor target page was not exported: pageId=${targetPageId} fragment=#${fragment}`,
      );
    }
  }

  exported = exported.map((res) => {
    const requiredAnchors = requiredAnchorsByPageId.get(res.id) || new Set();
    checkpoint(signal);
    const finalized = finalizePage(res, config, requiredAnchors, log);

    const outPath = savePage(finalized, config);
    log(`[info] Saved HTML: ${outPath}`);
    onEvent({ type: "page.saved", id: res.id, title: res.title, file: outPath });
    return finalized;
  });
  return exported;
}

module.exports = { exportPages };
