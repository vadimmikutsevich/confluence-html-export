const { absolutizeMaybe } = require("./utils.cjs");
const { fetchJson } = require("./http.cjs");

function parseConfluenceInput(input) {
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return { pageId: trimmed, pageUrl: null };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Не похоже ни на URL, ни на pageId: "${input}"`);
  }

  const m = url.pathname.match(/\/pages\/(\d+)(?:\/|$)/);
  if (!m) {
    throw new Error(`Не смог извлечь pageId из URL: ${trimmed}`);
  }
  return { pageId: m[1], pageUrl: url.toString() };
}

function deriveConfluenceBaseFromUrl(pageUrl) {
  const url = new URL(pageUrl);
  if (url.pathname.startsWith("/wiki")) return `${url.origin}/wiki`;
  return url.origin;
}

function extractConfluenceSpaceKeyFromUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const m = url.pathname.match(/\/spaces\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

function extractConfluencePageIdFromHref(href, confluenceBase) {
  const raw = String(href || "").trim();
  if (!raw) return null;
  if (/^(mailto:|tel:|data:|#)/i.test(raw)) return null;

  const abs = absolutizeMaybe(raw, confluenceBase);
  try {
    const u = new URL(abs);
    const base = new URL(confluenceBase);
    if (u.origin !== base.origin) return null;
    const m = u.pathname.match(/\/pages\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function createConfluenceClient({ confluenceBase, confluenceAuthHeader }) {
  const base = String(confluenceBase || "").replace(/\/+$/, "");
  const titleCache = new Map();
  const fullCache = new Map();

  const getTitleById = (id) => {
    const key = String(id);
    if (titleCache.has(key)) return titleCache.get(key);
    const url = `${base}/rest/api/content/${key}`;
    const p = fetchJson(url, {
      headers: { Authorization: confluenceAuthHeader },
    })
      .then((j) => String(j.title || "").trim())
      .catch(() => "");
    titleCache.set(key, p);
    return p;
  };

  const getFullById = (id) => {
    const key = String(id);
    if (fullCache.has(key)) return fullCache.get(key);
    const url = `${base}/rest/api/content/${key}?expand=body.export_view,space,version`;
    const p = fetchJson(url, {
      headers: { Authorization: confluenceAuthHeader },
    }).then((j) => {
      const title = String(j.title || "").trim();
      const html =
        (j.body && j.body.export_view && j.body.export_view.value) || "";
      const spaceKey = j.space && j.space.key ? String(j.space.key) : "";
      return { id: key, title, html, spaceKey };
    });
    fullCache.set(key, p);
    return p;
  };

  return {
    base,
    getFullById,
    getTitleById,
  };
}

module.exports = {
  createConfluenceClient,
  deriveConfluenceBaseFromUrl,
  extractConfluencePageIdFromHref,
  extractConfluenceSpaceKeyFromUrl,
  parseConfluenceInput,
};
