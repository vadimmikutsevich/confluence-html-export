const { fetchJson, fetchBinary } = require("./http.cjs");

function createConfluenceClient({ base: confluenceBase, user, token }) {
  const confluenceAuthHeader = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
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
    downloadImage: (src) => {
      if (parseConfluenceAttachmentImageUrl(src, base)) {
        return fetchConfluenceAttachmentBinary({
          src, confluenceBase: base, confluenceAuthHeader,
        });
      }
      const headers = new URL(src).origin === new URL(base).origin
        ? { Authorization: confluenceAuthHeader } : {};
      return fetchBinary(src, { headers });
    },
  };
}

function parseConfluenceAttachmentImageUrl(src, confluenceBase) {
  if (!src || !confluenceBase) return null;
  try {
    const url = new URL(src);
    const base = new URL(confluenceBase);
    if (url.origin !== base.origin) return null;

    const basePath = base.pathname.replace(/\/+$/, "");
    const prefixes = [
      `${basePath}/download/attachments/`,
      "/download/attachments/",
    ];
    const prefix = prefixes.find((p) => url.pathname.startsWith(p));
    if (!prefix) return null;

    const rest = url.pathname.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;

    return {
      pageId: decodeURIComponent(parts[0]),
      filename: decodeURIComponent(parts.slice(1).join("/")),
    };
  } catch {
    return null;
  }
}

async function fetchConfluenceAttachmentBinary({
  src,
  confluenceBase,
  confluenceAuthHeader,
}) {
  const attachment = parseConfluenceAttachmentImageUrl(src, confluenceBase);
  if (!attachment) return null;

  const listUrl =
    `${confluenceBase}/rest/api/content/${encodeURIComponent(
      attachment.pageId,
    )}/child/attachment?filename=${encodeURIComponent(attachment.filename)}`;

  const list = await fetchJson(listUrl, {
    headers: {
      Authorization: confluenceAuthHeader,
      Accept: "application/json",
    },
  }, { attempts: 1 });

  const items = Array.isArray(list.results) ? list.results : [];
  const exact = items.find(
    (item) => String(item.title || "") === attachment.filename,
  );
  const found = exact || items[0];
  if (!found || !found.id) {
    throw new Error(
      `Confluence attachment not found: pageId=${attachment.pageId}, filename=${attachment.filename}`,
    );
  }

  const downloadUrl =
    `${confluenceBase}/rest/api/content/${encodeURIComponent(
      attachment.pageId,
    )}/child/attachment/${encodeURIComponent(found.id)}/download`;

  return await fetchBinary(downloadUrl, {
    headers: {
      Authorization: confluenceAuthHeader,
      Accept: "*/*",
    },
  });
}

module.exports = { createConfluenceClient };
