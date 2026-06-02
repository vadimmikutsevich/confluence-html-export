const path = require("node:path");
const cheerio = require("cheerio");
const pLimitImport = require("p-limit");

const pLimit =
  typeof pLimitImport === "function" ? pLimitImport : pLimitImport.default;

const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);

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

function guessContentTypeByPathname(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.pathname.toLowerCase();
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
    if (p.endsWith(".gif")) return "image/gif";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".avif")) return "image/avif";
  } catch {
    // ignore
  }
  return "";
}

function sanitizeImageName(input, fallbackExt = ".png") {
  let s = String(input || "")
    .normalize("NFKC")
    .trim();
  s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/g, "");
  if (!s) return fallbackExt ? `image${fallbackExt}` : "";
  if (s.length > 170) {
    const ext = path.extname(s);
    const base = ext ? s.slice(0, -ext.length) : s;
    s = `${base.slice(0, 170 - ext.length).trim()}${ext}`;
  }
  if (!path.extname(s) && fallbackExt) s += fallbackExt;
  return s;
}

function imageNameFromUrl(src, contentType) {
  let name = "";
  try {
    const u = new URL(src);
    const last = u.pathname.split("/").filter(Boolean).pop();
    name = last ? decodeURIComponent(last) : "";
  } catch {
    // ignore
  }
  const fallbackExt =
    CONTENT_TYPE_EXTENSIONS.get(String(contentType || "").toLowerCase()) ||
    path.extname(name) ||
    ".png";
  return sanitizeImageName(name, fallbackExt);
}

function parseDataUri(dataUri) {
  const m = String(dataUri || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
  if (!m) return null;

  const contentType = (m[1] || "application/octet-stream").trim();
  const isBase64 = Boolean(m[2]);
  const payload = m[3] || "";
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  return { contentType, bytes };
}

async function fetchBinary(url, opts = {}) {
  const maxAttempts = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      const code = e && e.cause && e.cause.code ? String(e.cause.code) : "";
      const retriable = [
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
      ].includes(code);
      if (attempt < maxAttempts && retriable) {
        const waitMs = 400 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} while downloading ${url}\n${text.slice(0, 600)}`,
      );
    }

    const contentType = res.headers.get("content-type") || "";
    const ab = await res.arrayBuffer();
    return { contentType, bytes: Buffer.from(ab) };
  }
  throw lastErr || new Error(`Fetch failed for ${url}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 1200)}`);
  }
  return await res.json();
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
  });

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

async function uploadBookstackGalleryImage({
  bookstackBase,
  bsAuthHeader,
  pageId,
  name,
  contentType,
  bytes,
}) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!CONTENT_TYPE_EXTENSIONS.has(ct)) {
    throw new Error(`Unsupported BookStack image content type: ${ct || "empty"}`);
  }

  const form = new FormData();
  form.append("type", "gallery");
  form.append("uploaded_to", String(pageId));
  form.append("name", name);
  form.append("image", new Blob([bytes], { type: ct }), name);

  return await fetchJson(`${bookstackBase}/api/image-gallery`, {
    method: "POST",
    headers: {
      Authorization: bsAuthHeader,
      Accept: "application/json",
    },
    body: form,
  });
}

function preferredBookstackImageUrl(uploaded) {
  return (
    uploaded &&
    uploaded.thumbs &&
    (uploaded.thumbs.display || uploaded.thumbs.gallery)
  ) || (uploaded && uploaded.url) || "";
}

async function uploadImagesToBookstackGalleryInHtml(
  html,
  {
    bookstackBase,
    bsAuthHeader,
    pageId,
    confluenceBase,
    confluenceAuthHeader,
    concurrency = 4,
    maxBytes = 15_000_000,
    log = () => {},
  },
) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const bookstackOrigin = new URL(bookstackBase).origin;
  const confluenceOrigin = confluenceBase
    ? new URL(confluenceBase).origin
    : "";
  const confluenceAttachmentDownloads = new Map();

  $("img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) $(img).attr("src", absolutizeMaybe(src, confluenceBase));
  });

  const imgs = $("img").toArray();
  const limit = pLimit(concurrency);
  const bySrc = new Map();
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  await Promise.all(
    imgs.map((img) =>
      limit(async () => {
        const $img = $(img);
        const src = String($img.attr("src") || "").trim();
        if (!src) return;

        if (bySrc.has(src)) {
          const uploadedUrl = bySrc.get(src);
          $img.attr("src", uploadedUrl);
          const parent = $img.parent("a[href]");
          if (parent.length && parent.attr("href") === src) {
            parent.attr("href", uploadedUrl);
          }
          ok += 1;
          return;
        }

        try {
          if (!src.startsWith("data:")) {
            const srcUrl = new URL(src);
            if (srcUrl.origin === bookstackOrigin) {
              skipped += 1;
              return;
            }
          }

          let downloaded;
          if (src.startsWith("data:")) {
            downloaded = parseDataUri(src);
          } else {
            const attachment = parseConfluenceAttachmentImageUrl(
              src,
              confluenceBase,
            );
            if (attachment) {
              const cacheKey = `${attachment.pageId}/${attachment.filename}`;
              if (!confluenceAttachmentDownloads.has(cacheKey)) {
                confluenceAttachmentDownloads.set(
                  cacheKey,
                  fetchConfluenceAttachmentBinary({
                    src,
                    confluenceBase,
                    confluenceAuthHeader,
                  }),
                );
              }
              downloaded = await confluenceAttachmentDownloads.get(cacheKey);
            } else {
              downloaded = await fetchBinary(src, {
                headers:
                  confluenceOrigin && new URL(src).origin === confluenceOrigin
                    ? { Authorization: confluenceAuthHeader }
                    : {},
              });
            }
          }

          if (!downloaded) throw new Error("Could not parse data URI");
          if (maxBytes && downloaded.bytes.length > maxBytes) {
            throw new Error(
              `Image is too large: ${downloaded.bytes.length} bytes > ${maxBytes}`,
            );
          }

          const contentType =
            String(downloaded.contentType || "").split(";")[0].trim() ||
            guessContentTypeByPathname(src);
          const name =
            sanitizeImageName($img.attr("alt") || "", "") ||
            imageNameFromUrl(src, contentType);

          const uploaded = await uploadBookstackGalleryImage({
            bookstackBase,
            bsAuthHeader,
            pageId,
            name: sanitizeImageName(
              name,
              CONTENT_TYPE_EXTENSIONS.get(String(contentType).toLowerCase()) ||
                ".png",
            ),
            contentType,
            bytes: downloaded.bytes,
          });
          const uploadedUrl = preferredBookstackImageUrl(uploaded);
          if (!uploadedUrl) throw new Error("BookStack response had no image URL");

          bySrc.set(src, uploadedUrl);
          $img.attr("src", uploadedUrl);

          const parent = $img.parent("a[href]");
          if (parent.length && parent.attr("href") === src) {
            parent.attr("href", uploaded.url || uploadedUrl);
          }

          ok += 1;
          log(`[images] uploaded ${name} -> ${uploadedUrl}`);
        } catch (e) {
          fail += 1;
          log(
            `[warn] Could not upload image to BookStack gallery: ${src}\n${String(
              e && e.message ? e.message : e,
            )}`,
          );
        }
      }),
    ),
  );

  return {
    html: $("body").length ? $("body").html() : $.root().html(),
    stats: { ok, fail, skipped, unique: bySrc.size },
  };
}

module.exports = {
  uploadImagesToBookstackGalleryInHtml,
};
