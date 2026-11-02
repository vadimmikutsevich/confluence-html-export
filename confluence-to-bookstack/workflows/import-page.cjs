const { extractConfluenceSpaceKeyFromUrl } = require("../shared/urls.cjs");
const { preparePage, finalizePage } = require("./prepare-page.cjs");
const { transferImages } = require("./transfer-images.cjs");

async function importPage({ config, confluence, bookstack }) {
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

    console.log(
      `[info] No target book/chapter provided. Ensuring book "${desiredBookName}"...`,
    );
    const book = await bookstack.findOrCreateBook(desiredBookName);
    bookId = book.id;
    console.log(
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
  );
  const payload = {
    name: rootRendered.title,
    html: rootRendered.html,
  };
  if (config.chapterId) payload.chapter_id = config.chapterId;
  if (bookId) payload.book_id = bookId;

  const created = await bookstack.createPage(payload);

  console.log(
    `[ok] Created BookStack page id=${created.id} name="${created.name}"`,
  );

  if (created.id) {
    console.log(
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
        log: (msg) => console.log(msg),
      },
    );
    if (galleryImages.stats.ok || galleryImages.stats.fail) {
      await bookstack.updatePage({
        pageId: created.id,
        html: galleryImages.html || rootRendered.html,
        name: rootRendered.title,
      });
    }
    console.log(
      `[info] Images: deleted=${galleryImages.stats.deleted}, uploaded=${galleryImages.stats.ok}, failed=${galleryImages.stats.fail}, skipped=${galleryImages.stats.skipped}`,
    );
  }

  if (created.slug && created.book_slug) {
    console.log(
      `[ok] Likely URL: ${bookstack.base}/books/${created.book_slug}/page/${created.slug}`,
    );
  }
}

module.exports = { importPage };
