const { absolutizeMaybe } = require("../shared/urls.cjs");

function extractUrlFragment(href, base) {
  let fragment;
  try {
    fragment = new URL(absolutizeMaybe(href, base)).hash.slice(1);
  } catch {
    return "";
  }
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
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

function preserveReferencedAnchors($, { fragments, preserveIds }) {
  // Fragments are already decoded when collected from source links.
  const unresolved = [];
  const elementsWithAnchors = $("[id], [name]").toArray();

  for (const fragment of fragments) {
    const exact = elementsWithAnchors.find((el) => {
      const id = String($(el).attr("id") || "");
      const name = String($(el).attr("name") || "");
      return id === fragment || name === fragment;
    });

    if (exact) {
      const currentId = $(exact).attr("id");
      if (!currentId) $(exact).attr("id", fragment);
      if (currentId) preserveIds.add(currentId);
      preserveIds.add(fragment);
      continue;
    }
    unresolved.push(fragment);
  }

  return unresolved;
}

module.exports = { extractUrlFragment, normalizeAnchorsAndLinks, preserveReferencedAnchors };
