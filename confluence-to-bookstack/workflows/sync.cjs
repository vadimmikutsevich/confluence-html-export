const cheerio = require("cheerio");
const { rewriteConfluenceLinksToBookstack } = require("../html/links.cjs");
const { transferImages } = require("./transfer-images.cjs");

async function syncPages(exported, { config, confluence, bookstack }, log = console.log) {
  const configByName = config.pageMap;
  log(`[sync] Загружен конфиг: ${config.configPath} (${configByName.size} страниц)`);
  const titleById = new Map();
  for (const r of exported) titleById.set(r.id, r.title);
  const linkedIdsToResolve = new Set();
  for (const r of exported) {
    for (const linkedId of r.linkedIds || []) {
      if (!titleById.has(linkedId)) linkedIdsToResolve.add(linkedId);
    }
  }
  if (linkedIdsToResolve.size > 0) {
    log(`[sync] Resolve linked page titles: ${linkedIdsToResolve.size}`);
    for (const linkedId of linkedIdsToResolve) {
      const linkedTitle = await confluence.getTitleById(linkedId).catch(() => "");
      if (linkedTitle) titleById.set(linkedId, linkedTitle);
    }
  }
  log(`[sync] Экспортировано страниц: ${exported.length}`);

  let updated = 0;
  let skipped = 0;
  for (const res of exported) {
    log(`[sync] --- Обработка: "${res.title}" (id=${res.id}) ---`);
    const link = configByName.get(res.title);
    if (!link) {
      log(`[skip] Нет в конфиге: "${res.title}"`);
      skipped += 1;
      continue;
    }
    log(`[sync] Есть в конфиге, link=${link}`);

    const pageIdBs = await bookstack.resolvePageId(link);
    if (!pageIdBs) {
      log(`[warn] Не найден page в BookStack: ${link}`);
      skipped += 1;
      continue;
    }
    log(`[sync] BookStack page_id=${pageIdBs}, переписываем ссылки...`);

    const $ = cheerio.load(res.html, { decodeEntities: false });
    const linkRewriteStats = rewriteConfluenceLinksToBookstack($, {
      titleById,
      configByName,
      confluenceBase: confluence.base,
    });
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

    await bookstack.updatePage({
      pageId: pageIdBs,
      html: htmlToSend,
      name: res.title,
      log,
    });
    log(`[ok] Обновлена страница: "${res.title}" -> ${link}`);
    updated += 1;
  }
  log(`[sync] Итого: обновлено ${updated}, пропущено ${skipped}`);
}

module.exports = { syncPages };
