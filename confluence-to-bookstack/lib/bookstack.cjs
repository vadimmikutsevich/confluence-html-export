const fs = require("node:fs");
const yaml = require("js-yaml");
const { fetchJson } = require("./http.cjs");
const { requireNonEmpty } = require("./utils.cjs");

function bookstackAuthHeader(tokenId, tokenSecret) {
  return `Token ${tokenId}:${tokenSecret}`;
}

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

function parseBookstackPageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/books\/([^/]+)\/page\/([^/]+)/);
    return m ? { bookSlug: m[1], pageSlug: m[2] } : null;
  } catch {
    return null;
  }
}

async function resolveBookstackPageIdFromUrl({
  bookstackBase,
  bsAuthHeader,
  pageUrl,
  log = () => {},
}) {
  const parsed = parseBookstackPageUrl(pageUrl);
  if (!parsed) {
    log(`[bs] parseBookstackPageUrl failed for: ${pageUrl}`);
    return null;
  }
  log(
    `[bs] Ищем страницу: book_slug=${parsed.bookSlug} page_slug=${parsed.pageSlug}`,
  );

  const count = 100;
  let offset = 0;
  const maxPages = 100;

  for (let i = 0; i < maxPages; i += 1) {
    const url = `${bookstackBase}/api/pages?count=${count}&offset=${offset}`;
    log(`[bs] GET ${url}`);
    const list = await fetchJson(url, {
      headers: { Authorization: bsAuthHeader, Accept: "application/json" },
    });
    const items = Array.isArray(list.data)
      ? list.data
      : Array.isArray(list.results)
        ? list.results
        : [];
    const total = list.total != null ? list.total : items.length;
    log(
      `[bs] Получено ${items.length} страниц (total=${total}, offset=${offset})`,
    );
    if (items.length > 0 && offset === 0) {
      const sample = items[0];
      log(
        `[bs] Пример первой страницы: id=${sample.id} slug=${sample.slug} book_slug=${sample.book_slug} name="${sample.name}"`,
      );
    }

    for (const p of items) {
      const match =
        String(p.book_slug || "") === parsed.bookSlug &&
        String(p.slug || "") === parsed.pageSlug;
      if (match) {
        log(`[bs] Найдено: id=${p.id} name="${p.name}"`);
        return p.id;
      }
    }

    offset += items.length;
    if (items.length < count || offset >= total) break;
  }
  log(`[bs] Страница не найдена после просмотра ${offset} записей`);
  return null;
}

async function updateBookstackPage({
  bookstackBase,
  bsAuthHeader,
  pageId,
  html,
  name,
  log = () => {},
}) {
  const url = `${bookstackBase}/api/pages/${pageId}`;
  log(`[bs] PUT ${url} (name="${name}", htmlLen=${html ? html.length : 0})`);
  const res = await fetchJson(url, {
    method: "PUT",
    headers: {
      Authorization: bsAuthHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ html, name }),
  });
  log(`[bs] PUT ответ: id=${res.id} name="${res.name}"`);
  return res;
}

async function findOrCreateBook({ bookstackBase, bsAuthHeader, desiredName }) {
  const name = String(desiredName || "").trim();
  requireNonEmpty(name, "Пустое имя книги для BookStack");

  const like = encodeURIComponent(`%${name}%`);
  const listUrl = `${bookstackBase}/api/books?count=500&filter[name:like]=${like}`;
  const listing = await fetchJson(listUrl, {
    headers: { Authorization: bsAuthHeader, Accept: "application/json" },
  });

  const items = Array.isArray(listing.data) ? listing.data : [];
  const exact = items.find(
    (b) =>
      String(b.name || "")
        .trim()
        .toLowerCase() === name.toLowerCase(),
  );
  if (exact && exact.id)
    return { id: exact.id, name: exact.name, existed: true };

  const createUrl = `${bookstackBase}/api/books`;
  const created = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Authorization: bsAuthHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name,
      description_html: `<p>Imported from Confluence.</p>`,
    }),
  });

  return { id: created.id, name: created.name, existed: false };
}

module.exports = {
  bookstackAuthHeader,
  findOrCreateBook,
  loadBookstackConfig,
  parseBookstackPageUrl,
  resolveBookstackPageIdFromUrl,
  updateBookstackPage,
};
