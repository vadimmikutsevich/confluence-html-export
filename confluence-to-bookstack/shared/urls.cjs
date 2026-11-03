function absolutizeMaybe(urlStr, base) {
  if (!urlStr) return urlStr;
  const s = String(urlStr).trim();
  if (!s) return s;
  if (/^(data:|mailto:|tel:|#)/i.test(s)) return s;
  try {
    return new URL(s, base).toString();
  } catch {
    return s;
  }
}

function parseConfluenceInput(input) {
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return { pageId: trimmed, pageUrl: null };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Не похоже ни на URL, ни на pageId: "${input}"`);
  }

  const m = url.pathname.match(/\/pages\/(\d+)(?:\/|$)/i);
  if (!m) {
    throw new Error(`Не смог извлечь pageId из URL: ${trimmed}`);
  }
  return { pageId: m[1], pageUrl: url.toString() };
}

function deriveConfluenceBaseFromUrl(pageUrl) {
  const url = new URL(pageUrl);
  if (/^\/wiki(?:\/|$)/i.test(url.pathname)) return `${url.origin}/wiki`;
  return url.origin;
}

function extractConfluenceSpaceKeyFromUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const m = url.pathname.match(/\/spaces\/([^/]+)\//i);
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
    const m = u.pathname.match(/\/pages\/(\d+)(?:\/|$)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

module.exports = { absolutizeMaybe, parseConfluenceInput, deriveConfluenceBaseFromUrl, extractConfluenceSpaceKeyFromUrl, extractConfluencePageIdFromHref };
