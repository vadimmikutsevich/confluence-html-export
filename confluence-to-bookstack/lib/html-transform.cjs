const pLimitImport = require("p-limit");
const { absolutizeMaybe } = require("./utils.cjs");
const { extractConfluencePageIdFromHref } = require("./confluence.cjs");

const pLimit =
  typeof pLimitImport === "function" ? pLimitImport : pLimitImport.default;

function looksLikeUrlText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (!/^https?:\/\//i.test(t)) return false;
  return true;
}

function looksLikeJoinedMixedScriptText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /[A-Za-z][\u0400-\u04FF]|[\u0400-\u04FF][A-Za-z]/.test(t);
}

function normalizeAnchorsAndLinks(
  $,
  { pageUrl, pageId, confluenceBase, rewriteSelfLinks = true },
) {
  const preserveIds = new Set(["__root"]);
  let rewrittenSelfLinks = 0;

  const normalizeText = (text, { treatHyphenAsSpace } = {}) => {
    let t = String(text || "")
      .trim()
      .toLowerCase();
    if (!t) return "";
    if (treatHyphenAsSpace) t = t.replace(/-/g, " ");
    t = t.replace(/\s+/g, " ");
    t = t.replace(/[^\p{L}\p{N}]+/gu, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  };

  const normalizeHash = (hash) => {
    if (!hash) return "";
    let h = String(hash).trim();
    if (!h) return "";
    if (h.startsWith("#")) h = h.slice(1);
    try {
      h = decodeURIComponent(h);
    } catch {
      // ignore
    }
    h = h.replace(/[.)\]]+$/g, "");
    return h;
  };

  const isSameConfluencePage = (hrefAbs) => {
    if (!hrefAbs) return false;
    try {
      const u = new URL(hrefAbs);
      return new RegExp(`/pages/${pageId}(?:/|$)`).test(u.pathname);
    } catch {
      return false;
    }
  };

  const getNiceAnchorText = (anchorToken) => {
    const token = String(anchorToken || "").trim();
    if (!token) return "";

    const byId = $(`[id="${token}"]`);
    if (byId && byId.length) {
      const t = String(byId.first().text() || "").trim();
      if (t) return t;
    }

    return token.replace(/-/g, " ");
  };

  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    if (!href) return;

    if (href.startsWith("#")) {
      const t = normalizeHash(href);
      if (t) preserveIds.add(t);
      return;
    }

    const abs = absolutizeMaybe(href, confluenceBase);
    if (!rewriteSelfLinks) return;

    if (abs.includes("#") && isSameConfluencePage(abs)) {
      const u = new URL(abs);
      const t = normalizeHash(u.hash);
      if (t) {
        $(a).attr("href", `#${t}`);
        preserveIds.add(t);
        rewrittenSelfLinks += 1;

        const currentText = String($(a).text() || "").trim();
        const looksLikeUrl =
          /^https?:\/\//i.test(currentText) &&
          currentText.includes(`/pages/${pageId}`) &&
          currentText.includes("#");
        if (looksLikeUrl || currentText === abs || currentText === href) {
          const nice = getNiceAnchorText(t);
          if (nice) $(a).text(nice);
        }
      }
    }
  });

  const headings = $("h1,h2,h3,h4,h5,h6").toArray();
  const headingByText = new Map();
  headings.forEach((h) => {
    const text = $(h).text();
    const key = normalizeText(text);
    if (!key) return;
    if (!headingByText.has(key)) headingByText.set(key, h);
    const id = $(h).attr("id");
    if (id) preserveIds.add(String(id));
  });

  $('a[href^="#id-"]').each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    const desiredId = normalizeHash(href);
    const linkText = $(a).text();
    const key = normalizeText(linkText);
    if (!desiredId || !key) return;
    preserveIds.add(desiredId);

    const heading = headingByText.get(key);
    if (!heading) return;
    const currentId = $(heading).attr("id");
    if (!currentId) {
      $(heading).attr("id", desiredId);
    }
    preserveIds.add($(heading).attr("id"));
  });

  $('a[href^="#"]').each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    if (!href || href.startsWith("#id-")) return;
    const decoded = normalizeHash(href);
    if (!decoded) return;

    const key = normalizeText(decoded, { treatHyphenAsSpace: true });
    if (!key) return;
    const heading = headingByText.get(key);
    if (!heading) return;

    let hid = $(heading).attr("id");
    if (!hid) {
      hid = `id-${$(heading).text().trim().replace(/\s+/g, "")}`;
      $(heading).attr("id", hid);
    }
    preserveIds.add(hid);
    $(a).attr("href", `#${hid}`);
  });

  $("[name]").each((_, el) => {
    const name = String($(el).attr("name") || "").trim();
    if (!name) return;
    if (!$(el).attr("id")) $(el).attr("id", name);
    preserveIds.add(name);
  });

  return { preserveIds, rewrittenSelfLinks, pageUrl: pageUrl || null };
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

async function humanizeConfluenceLinkText(
  $,
  {
    currentPageId,
    confluenceBase,
    getTitleById,
    rewriteSamePageHrefToHash = true,
  },
) {
  const base = confluenceBase;
  const tasks = [];
  const limit = pLimit(6);

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = String($a.attr("href") || "").trim();
    if (!href) return;

    const linkedId = extractConfluencePageIdFromHref(href, base);
    if (!linkedId) return;

    tasks.push(
      limit(async () => {
        if (rewriteSamePageHrefToHash) {
          try {
            const abs = absolutizeMaybe(href, base);
            const u = new URL(abs);
            if (linkedId === String(currentPageId) && u.hash) {
              const h = decodeURIComponent(u.hash.replace(/^#/, ""));
              $a.attr("href", `#${h}`);
            }
          } catch {
            // ignore
          }
        }

        const text = $a.text();
        const shouldUseTitle =
          looksLikeUrlText(text) || looksLikeJoinedMixedScriptText(text);
        if (!shouldUseTitle) return;

        const title = await getTitleById(linkedId).catch(() => "");
        if (title) $a.text(title);
      }),
    );
  });

  await Promise.all(tasks);
}

function rewriteConfluenceLinksToBookstack(
  $,
  { titleById, configByName, confluenceBase },
) {
  const base = confluenceBase;
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    if (!href || href.startsWith("#")) return;

    const linkedId = extractConfluencePageIdFromHref(href, base);
    if (!linkedId) return;

    const title = titleById.get(linkedId);
    if (!title) return;

    const link = configByName.get(title);
    if (!link) return;

    try {
      const abs = absolutizeMaybe(href, base);
      const u = new URL(abs);
      const hash = u.hash || "";
      $(a).attr("href", link + hash);
    } catch {
      $(a).attr("href", link);
    }
  });
}

module.exports = {
  humanizeConfluenceLinkText,
  normalizeAnchorsAndLinks,
  rewriteConfluenceLinksToBookstack,
  stripConfluenceNoise,
};
