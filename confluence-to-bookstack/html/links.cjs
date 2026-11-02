const { absolutizeMaybe, extractConfluencePageIdFromHref } = require("../shared/urls.cjs");

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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isConfluenceBaseHref(href, confluenceBase) {
  const raw = String(href || "").trim();
  if (!raw || /^(mailto:|tel:|data:|#)/i.test(raw)) return false;

  try {
    const abs = absolutizeMaybe(raw, confluenceBase);
    const u = new URL(abs);
    const base = new URL(confluenceBase);
    if (u.origin !== base.origin) return false;

    const basePath = String(base.pathname || "").replace(/\/+$/, "");
    const confluencePathPattern = new RegExp(
      `^${escapeRegExp(basePath)}(?:/|$)`,
    );
    return confluencePathPattern.test(u.pathname);
  } catch {
    return false;
  }
}

function humanizeConfluenceLinkText(
  $,
  {
    currentPageId,
    confluenceBase,
    titleById,
    rewriteSamePageHrefToHash = true,
  },
) {
  const base = confluenceBase;

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = String($a.attr("href") || "").trim();
    if (!href) return;

    const linkedId = extractConfluencePageIdFromHref(href, base);
    if (!linkedId) return;

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

    const title = titleById.get(linkedId);
    if (title) $a.text(title);
  });

}

function rewriteConfluenceLinksToBookstack(
  $,
  { titleById, configByName, confluenceBase },
) {
  const base = confluenceBase;
  const stats = { rewritten: 0, disabled: 0, unresolved: [] };

  const disableLink = ($a, href, { linkedId = "", title = "", reason = "" }) => {
    stats.disabled += 1;
    stats.unresolved.push({
      href,
      linkedId,
      title,
      reason,
      text: String($a.text() || "").trim(),
    });

    const contents = $a.contents();
    if (contents.length) {
      $a.replaceWith(contents);
    } else {
      $a.replaceWith($a.text() || href);
    }
  };

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = String($a.attr("href") || "").trim();
    if (!href || href.startsWith("#")) return;

    const linkedId = extractConfluencePageIdFromHref(href, base);
    if (!linkedId) {
      if (isConfluenceBaseHref(href, base)) {
        disableLink($a, href, { reason: "not-a-confluence-page-link" });
      }
      return;
    }

    const title = titleById.get(linkedId);
    if (!title) {
      if (isConfluenceBaseHref(href, base)) {
        disableLink($a, href, { linkedId, reason: "title-not-resolved" });
      }
      return;
    }

    const link = configByName.get(title);
    if (!link) {
      if (isConfluenceBaseHref(href, base)) {
        disableLink($a, href, {
          linkedId,
          title,
          reason: "missing-bookstack-config-match",
        });
      }
      return;
    }

    try {
      const abs = absolutizeMaybe(href, base);
      const u = new URL(abs);
      const hash = u.hash || "";
      $a.attr("href", link + hash);
    } catch {
      $a.attr("href", link);
    }
    stats.rewritten += 1;
  });

  return stats;
}

module.exports = { humanizeConfluenceLinkText, rewriteConfluenceLinksToBookstack };
