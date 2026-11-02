const cheerio = require("cheerio");
const { extractConfluencePageIdFromHref } = require("../shared/urls.cjs");
const { classifyConfluenceImages } = require("./images.cjs");
const { humanizeConfluenceLinkText } = require("./links.cjs");
const {
  extractUrlFragment,
  normalizeAnchorsAndLinks,
  preserveReferencedAnchors,
} = require("./anchors.cjs");
const { removeConfluencePageToc, stripConfluenceNoise } = require("./cleanup.cjs");

function collectLinkedPageIds(html, confluenceBase) {
  const $ = cheerio.load(html);
  const ids = new Set();
  $("a[href]").each((_, link) => {
    const id = extractConfluencePageIdFromHref($(link).attr("href"), confluenceBase);
    if (id) ids.add(id);
  });
  return ids;
}

function preparePage(
  page,
  { title: titleOverride, pageUrl, confluenceBase },
  titleById,
) {
  const id = page.id;
  const title = titleOverride || page.title || `Confluence page ${id}`;

  if (!String(page.html || "").trim()) {
    throw new Error(`Confluence вернул пустой body.export_view (pageId=${id})`);
  }
  const html = `<div id="__root">${page.html}</div>`;

  const $ = cheerio.load(html, { decodeEntities: false });
  classifyConfluenceImages($);
  removeConfluencePageToc($);

  // Improve link text (URL -> title) for Confluence page links.
  humanizeConfluenceLinkText($, {
    currentPageId: id,
    confluenceBase,
    titleById,
    rewriteSamePageHrefToHash: true,
  });

  // Normalize anchors within page (self-links, pretty anchors, etc).
  const normalized = normalizeAnchorsAndLinks($, {
    pageUrl: pageUrl || null,
    pageId: id,
    confluenceBase,
    rewriteSelfLinks: true,
  });

  // Collect linked page ids and cross-page fragments after normalization.
  const linkedIds = new Set();
  const linkedAnchors = [];
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    const pid = extractConfluencePageIdFromHref(href, confluenceBase);
    if (pid && pid !== String(id)) {
      linkedIds.add(pid);
      const fragment = extractUrlFragment(href, confluenceBase);
      if (fragment) linkedAnchors.push({ pageId: pid, fragment });
    }
  });

  // Keep the complete prepared document until the second pass so both
  // fragment and --no-fragment output modes retain their old semantics.
  const preparedHtml = $.root().html();

  return {
    id: String(id),
    title,
    preparedHtml,
    preserveIds: [...normalized.preserveIds],
    linkedIds,
    linkedAnchors,
  };
}

function finalizePage(prepared, { keepIds, fragment }, requiredAnchors = []) {
  const $ = cheerio.load(prepared.preparedHtml, { decodeEntities: false });
  const preserveIds = new Set(prepared.preserveIds || []);
  const unresolved = preserveReferencedAnchors($, {
    fragments: requiredAnchors,
    preserveIds,
  });

  stripConfluenceNoise($, {
    keepIds: Boolean(keepIds),
    preserveIds,
  });

  let html;
  if (fragment) {
    html = $("body").length ? $("body").html() || "" : $.root().html();
  } else {
    html = $.root().html();
  }

  return {
    id: prepared.id,
    title: prepared.title,
    linkedIds: prepared.linkedIds,
    html,
    unresolvedAnchors: unresolved,
  };
}

module.exports = { preparePage, finalizePage, collectLinkedPageIds };
