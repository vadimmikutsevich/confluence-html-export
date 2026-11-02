const { extractConfluenceSpaceKeyFromUrl } = require("../shared/urls.cjs");
const { preparePage, finalizePage } = require("./prepare-page.cjs");
const { transferImages } = require("./transfer-images.cjs");
const { checkpoint } = require("./progress.cjs");

async function importPage({ config, confluence, bookstack, signal, onEvent = () => {}, log = console.log }) {
  checkpoint(signal);
  onEvent({ type: "page.started", phase: "import", id: config.pageId });
  const { pageId, pageUrl } = config;
  let bookId = config.bookId;
  // If target is not specified, ensure a BookStack book exists and use it.
  if (!bookId && !config.chapterId) {
    const derivedSpace = pageUrl
      ? extractConfluenceSpaceKeyFromUrl(pageUrl)
      : "";
    const desiredBookName =
      (config.bookName && String(config.bookName).trim()) ||
      (derivedSpace ? `Confluence: ${derivedSpace}` : "Confluence Imports");

    log(
      `[info] No target book/chapter provided. Ensuring book "${desiredBookName}"...`,
    );
    const book = await bookstack.findOrCreateBook(desiredBookName);
    bookId = book.id;
    log(
      `[info] Using book_id=${book.id} (${book.existed ? "found" : "created"})`,
    );
  }

  // Non dry-run mode: create single page (root only) in BookStack.
  const rootRendered = finalizePage(
    await preparePage(
      { id: String(pageId), pageUrlForThis: pageUrl },
      { config, confluence },
    ),
    config,
    [],
    log,
  );
  const payload = {
    name: rootRendered.title,
    html: rootRendered.html,
  };
  if (config.chapterId) payload.chapter_id = config.chapterId;
  if (bookId) payload.book_id = bookId;

  const created = await bookstack.createPage(payload);

  onEvent({ type: "page.created", id: config.pageId, bookstackId: created.id });
  log(
    `[ok] Created BookStack page id=${created.id} name="${created.name}"`,
  );

  if (created.id) {
    log(
      `[info] Upload images to BookStack gallery for page_id=${created.id}...`,
    );
    const galleryImages = await transferImages(
      rootRendered.html,
      {
        bookstack,
        pageId: created.id,
        confluence,
        concurrency: config.concurrency,
        maxBytes: config.maxBytes,
        log,
        onEvent,
      },
    );
    if (galleryImages.stats.ok || galleryImages.stats.fail) {
      await bookstack.updatePage({
        pageId: created.id,
        html: galleryImages.html || rootRendered.html,
        name: rootRendered.title,
      });
    }
    log(
      `[info] Images: deleted=${galleryImages.stats.deleted}, uploaded=${galleryImages.stats.ok}, failed=${galleryImages.stats.fail}, skipped=${galleryImages.stats.skipped}`,
    );
  }

  if (created.slug && created.book_slug) {
    log(
      `[ok] Likely URL: ${bookstack.base}/books/${created.book_slug}/page/${created.slug}`,
    );
  }
  onEvent({
    type: "page.completed",
    id: config.pageId,
    title: rootRendered.title,
    url: created.slug && created.book_slug
      ? `${bookstack.base}/books/${created.book_slug}/page/${created.slug}` : null,
  });
}

module.exports = { importPage };
