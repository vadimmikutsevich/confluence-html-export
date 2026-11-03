const { createHash } = require("node:crypto");
const cheerio = require("cheerio");

function stableAnchorId(fragment) {
  return `bkmrk-cf-${createHash("sha256").update(String(fragment)).digest("hex").slice(0, 32)}`;
}

function decodeFragment(fragment) {
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}

// bkmrk-prefixed IDs are preserved by BookStack's HTML formatter.
function installStableAnchors($, preserveIds) {
  const anchors = new Map();
  const used = new Set();
  const elements = $("[id], [name]").toArray();
  for (const element of elements) {
    const $element = $(element);
    const originalId = $element.attr("id");
    if (originalId === "__root") continue;
    const tokens = [...new Set([originalId, $element.attr("name")].filter(Boolean))];
    let primary = true;
    for (const token of tokens) {
      if (anchors.has(token)) continue;
      const id = stableAnchorId(token);
      if (used.has(id)) throw new Error("Конфликт стабильных якорей");
      used.add(id);
      anchors.set(token, id);
      preserveIds.add(id);
      if (primary) {
        $element.attr("id", id);
        primary = false;
      } else {
        $("<span></span>").attr("id", id).insertBefore($element);
      }
    }
    // Repeated source IDs must not turn into repeated BookStack IDs.
    if (primary && originalId) $element.removeAttr("id");
  }
  $('a[href^="#"]').each((_, element) => {
    const href = $(element).attr("href");
    const alias = anchors.get(decodeFragment(href.slice(1)));
    if (alias) $(element).attr("href", `#${alias}`);
  });
  return anchors;
}

function savedAnchorMap(page) {
  const $ = cheerio.load(page.raw_html ?? page.html ?? "");
  const present = new Set();
  $("[id], [name]").each((_, element) => {
    for (const value of [$(element).attr("id"), $(element).attr("name")]) if (value) present.add(value);
  });
  return { get(fragment) {
    const stable = stableAnchorId(fragment);
    if (present.has(stable)) return stable;
    return present.has(fragment) ? fragment : undefined;
  } };
}

module.exports = { stableAnchorId, installStableAnchors, savedAnchorMap, decodeFragment };
