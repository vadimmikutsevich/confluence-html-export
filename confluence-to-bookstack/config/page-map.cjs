const fs = require("node:fs");
const yaml = require("js-yaml");

function loadBookstackConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  const data = yaml.load(raw);
  const map = new Map();
  if (!data || !Array.isArray(data.books)) return map;
  for (const book of data.books) {
    const pages = book.pages;
    if (!Array.isArray(pages)) continue;
    for (const p of pages) {
      const name = String(p.name || "").trim();
      const link = String(p.link || "").trim();
      if (name && link) map.set(name, link);
    }
  }
  return map;
}

module.exports = { loadBookstackConfig };
