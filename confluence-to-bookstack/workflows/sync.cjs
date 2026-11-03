const cheerio = require("cheerio");
const { rewriteConfluenceLinksToBookstack } = require("../html/links.cjs");
const { transferImages } = require("./transfer-images.cjs");
const { checkpoint } = require("./progress.cjs");
const { prepareSyncPlan } = require("./page-registry.cjs");
const { savedAnchorMap } = require("../html/stable-anchors.cjs");

async function syncPages(exported, { config, confluence, bookstack, signal, onEvent = () => {} }, log = console.log) {
  const release = config.pageMap.acquireRunLock();
  try {
    return await runSync(exported, { config, confluence, bookstack, signal, onEvent }, log);
  } finally { release(); }
}

async function runSync(exported, { config, confluence, bookstack, signal, onEvent }, log) {
  onEvent({ type: "phase", phase: "sync", total: exported.length });
  const plan = await prepareSyncPlan(exported, { config, confluence, bookstack, signal }, log);
  const { registry, targets } = plan;
  const exportedById = new Map(exported.map(page => [String(page.id), page]));
  for (const [id, target] of targets) {
    target.anchors = exportedById.get(id)?.anchors || savedAnchorMap(target.page);
  }
  if (config.dryRun) {
    log(`[dry-run] План проверен: ${targets.size} соответствий; BookStack и конфиг не изменены`);
    return plan;
  }
  // Persist verified identities before the first remote write, so a failed run
  // can resume even when some titles/slugs have already changed.
  checkpoint(signal);
  registry.save();
  log(`[sync] Экспортировано страниц: ${exported.length}`);

  let updated = 0;
  let skipped = 0;
  for (const res of exported) {
    checkpoint(signal);
    onEvent({ type: "page.started", phase: "sync", id: res.id, title: res.title });
    log(`[sync] --- Обработка: "${res.title}" (id=${res.id}) ---`);
    const target = targets.get(String(res.id));
    if (!target) {
      log(`[skip] Нет в конфиге: "${res.title}"`);
      skipped += 1;
      onEvent({ type: "page.skipped", id: res.id, title: res.title, reason: "Нет в карте страниц" });
      continue;
    }
    const pageIdBs = target.page.id;
    log(`[sync] BookStack page_id=${pageIdBs}, переписываем ссылки...`);

    const $ = cheerio.load(res.html, { decodeEntities: false });
    const linkRewriteStats = rewriteConfluenceLinksToBookstack($, {
      targets,
      confluenceBase: confluence.base,
    });
    for (const missing of linkRewriteStats.missingAnchors) {
      log(`[warn] Блок #${missing.fragment} на странице ${missing.linkedId} не подтверждён; ссылка ведёт на начало страницы`);
    }
    if (linkRewriteStats.rewritten || linkRewriteStats.disabled) {
      log(
        `[sync] Links: rewritten=${linkRewriteStats.rewritten}, disabled=${linkRewriteStats.disabled}`,
      );
    }
    if (linkRewriteStats.disabled > 0) {
      for (const item of linkRewriteStats.unresolved.slice(0, 5)) {
        const label = item.title || item.text || item.linkedId || item.href;
        log(`[warn] Disabled Confluence link: ${label} -> ${item.href}`);
      }
      if (linkRewriteStats.unresolved.length > 5) {
        log(
          `[warn] ... and ${linkRewriteStats.unresolved.length - 5} more disabled Confluence links`,
        );
      }
    }
    const html = $("body").length
      ? $("body").html()
      : $("#__root").length
        ? $("#__root").html()
        : $.root().html();
    let htmlToSend = html || res.html;

    log(
      `[sync] Upload images to BookStack gallery for page_id=${pageIdBs}...`,
    );
    const galleryImages = await transferImages(
      htmlToSend,
      {
        bookstack,
        pageId: pageIdBs,
        confluence,
        concurrency: config.concurrency,
        maxBytes: config.maxBytes,
        log,
        onEvent,
      },
    );
    htmlToSend = galleryImages.html || htmlToSend;
    log(
      `[sync] Images: deleted=${galleryImages.stats.deleted}, uploaded=${galleryImages.stats.ok}, failed=${galleryImages.stats.fail}, skipped=${galleryImages.stats.skipped}`,
    );
    if (galleryImages.stats.fail > 0) {
      throw new Error(
        `Image gallery upload failed for ${galleryImages.stats.fail} image(s); skip BookStack page update.`,
      );
    }
    log(`[sync] Отправка HTML (${htmlToSend.length} символов)...`);

    const updatedPage = await bookstack.updatePage({
      pageId: pageIdBs,
      html: htmlToSend,
      name: res.title,
      log,
    });
    const saved = updatedPage.raw_html != null || updatedPage.html != null ? updatedPage : await bookstack.getPage(pageIdBs);
    const actualAnchors = savedAnchorMap(saved);
    for (const [fragment, alias] of res.anchors || []) {
      if (actualAnchors.get(fragment) !== alias) throw new Error(`BookStack изменил стабильный якорь #${fragment}; проверьте обработку HTML на сервере`);
    }
    target.entry.link = await bookstack.canonicalUrl(updatedPage);
    registry.save();
    log(`[ok] Обновлена страница: "${res.title}" -> ${target.entry.link}`);
    updated += 1;
    onEvent({ type: "page.completed", id: res.id, title: res.title, url: target.url });
  }
  log(`[sync] Итого: обновлено ${updated}, пропущено ${skipped}`);
}

module.exports = { syncPages };
