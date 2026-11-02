const fs = require("node:fs");
const path = require("node:path");

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

function savePage(page, { outDir, out, pageId }) {
  const filename = page.id === pageId && out
    ? out
    : path.join(outDir, `${sanitizeFilename(page.title)}__${page.id}.fragment.html`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, page.html, "utf8");
  return filename;
}

module.exports = { savePage };
