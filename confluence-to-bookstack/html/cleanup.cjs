function normalizeComparableText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripConfluenceNoise($, { keepIds, preserveIds }) {
  $("script, style, meta, link, noscript").remove();

  const allowed = new Set([
    "href",
    "src",
    "alt",
    "title",
    "colspan",
    "rowspan",
    "target",
    "rel",
    "width",
    "height",
    "aria-label",
    "aria-hidden",
    "name",
  ]);

  $("*").each((_, el) => {
    const attribs = el.attribs || {};
    for (const [name] of Object.entries(attribs)) {
      if (name === "id" && attribs.id === "__root") continue;
      if (name === "id" && keepIds) continue;
      if (name === "id" && preserveIds && preserveIds.has(attribs.id)) continue;
      if (name === "id" && !keepIds) {
        $(el).removeAttr("id");
        continue;
      }
      if (name === "class") {
        if (el.name === "img") {
          const kept = String(attribs.class || "")
            .split(/\s+/)
            .filter((className) => className.startsWith("c2b-img"))
            .join(" ");
          if (kept) {
            $(el).attr("class", kept);
          } else {
            $(el).removeAttr("class");
          }
          continue;
        }
        $(el).removeAttr("class");
        continue;
      }
      if (name.startsWith("data-")) {
        $(el).removeAttr(name);
        continue;
      }
      if (!allowed.has(name)) {
        if (name === "style") continue;
        $(el).removeAttr(name);
      }
    }
  });
}

function removeConfluencePageToc($) {
  let removed = 0;

  const headingById = new Map();
  $("h1,h2,h3,h4,h5,h6").each((_, heading) => {
    const id = String($(heading).attr("id") || "").trim();
    if (!id) return;
    headingById.set(id, normalizeComparableText($(heading).text()));
  });

  const isLocalHeadingHref = (href) => {
    const raw = String(href || "").trim();
    if (!raw.startsWith("#")) return false;
    let id = raw.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // ignore
    }
    return headingById.has(id);
  };

  const isStrictTocCandidate = ($candidate) => {
    if (!$candidate || !$candidate.length || headingById.size === 0) return false;

    const disallowed = $candidate
      .find("*")
      .toArray()
      .some((el) => {
        const tag = String(el.tagName || el.name || "").toLowerCase();
        return !["div", "nav", "ul", "ol", "li", "a", "span"].includes(tag);
      });
    if (disallowed) return false;

    const anchors = $candidate.find("a[href]").toArray();
    if (anchors.length < 2) return false;

    let validLocalHeadingLinks = 0;
    let matchingTextLinks = 0;
    for (const a of anchors) {
      const href = String($(a).attr("href") || "").trim();
      if (!isLocalHeadingHref(href)) return false;
      validLocalHeadingLinks += 1;

      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // ignore
      }
      const linkText = normalizeComparableText($(a).text());
      const headingText = headingById.get(id);
      if (linkText && headingText && linkText === headingText) {
        matchingTextLinks += 1;
      }
    }

    return (
      validLocalHeadingLinks === anchors.length &&
      matchingTextLinks / anchors.length >= 0.6
    );
  };

  const removeCandidate = ($candidate) => {
    if (!$candidate || !$candidate.length) return false;
    $candidate.remove();
    removed += 1;
    return true;
  };

  const macroSelectors = [
    '[data-macro-name="toc"]',
    '[data-macro-name="table-of-contents"]',
    ".toc-macro",
    ".toc",
    ".table-of-contents",
    ".confluenceTableOfContents",
  ];

  for (const selector of macroSelectors) {
    $(selector).each((_, el) => {
      const $candidate = $(el);
      if (isStrictTocCandidate($candidate)) removeCandidate($candidate);
    });
  }

  const $root = $("#__root").first();
  if (!$root.length) return { removed };

  const children = $root.children().toArray();
  const firstHeadingIndex = children.findIndex((el) =>
    /^h[1-6]$/i.test(String(el.tagName || el.name || "")),
  );
  if (firstHeadingIndex <= 0) return { removed };

  const candidatesBeforeHeading = children.slice(0, firstHeadingIndex);
  const meaningful = candidatesBeforeHeading.filter((el) => {
    const text = String($(el).text() || "").trim();
    const hasList = $(el).is("ul,ol") || $(el).find("ul,ol").length > 0;
    return text || hasList;
  });
  if (meaningful.length !== 1) return { removed };

  const $candidate = $(meaningful[0]);
  if (
    ($candidate.is("ul,ol") || $candidate.children("ul,ol").length === 1) &&
    isStrictTocCandidate($candidate)
  ) {
    removeCandidate($candidate);
  }

  return { removed };
}

module.exports = { stripConfluenceNoise, removeConfluencePageToc };
