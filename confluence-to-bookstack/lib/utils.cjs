const fs = require("node:fs");

function requireNonEmpty(value, message) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(message);
  }
  return value;
}

function basicAuthHeader(user, token) {
  const raw = `${user}:${token}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function sanitizeFilename(input, { maxLen = 140 } = {}) {
  let s = String(input || "")
    .normalize("NFKC")
    .trim();
  s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/g, "");
  if (!s) s = "untitled";

  const upper = s.toUpperCase();
  const reserved =
    upper === "CON" ||
    upper === "PRN" ||
    upper === "AUX" ||
    upper === "NUL" ||
    /^COM[1-9]$/.test(upper) ||
    /^LPT[1-9]$/.test(upper);
  if (reserved) s = `_${s}`;

  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

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

module.exports = {
  absolutizeMaybe,
  basicAuthHeader,
  ensureDirSync,
  requireNonEmpty,
  sanitizeFilename,
};
