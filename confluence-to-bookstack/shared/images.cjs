const path = require("node:path");

const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);

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

function preferredBookstackImageUrl(uploaded) {
  return (
    uploaded &&
    uploaded.thumbs &&
    (uploaded.thumbs.display || uploaded.thumbs.gallery)
  ) || (uploaded && uploaded.url) || "";
}

module.exports = { CONTENT_TYPE_EXTENSIONS, guessContentTypeByPathname, sanitizeImageName, imageNameFromUrl, parseDataUri, preferredBookstackImageUrl };
