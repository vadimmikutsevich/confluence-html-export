const { fetchJson } = require("./http.cjs");
const { normalizeLookupKey } = require("../shared/matching.cjs");
const {
  uploadBookstackGalleryImage,
  deleteBookstackGalleryImagesForPage,
} = require("./bookstack-gallery.cjs");

function parseBookstackPageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/books\/([^/]+)\/page\/([^/]+)/i);
    return m ? { bookSlug: m[1], pageSlug: m[2] } : null;
  } catch {
    return null;
  }
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
  if (!name) throw new Error("Пустое имя книги для BookStack");

  const like = encodeURIComponent(`%${name}%`);
  const listUrl = `${bookstackBase}/api/books?count=500&filter[name:like]=${like}`;
  const listing = await fetchJson(listUrl, {
    headers: { Authorization: bsAuthHeader, Accept: "application/json" },
  });

  const items = Array.isArray(listing.data) ? listing.data : [];
  const exact = items.find(
    (b) =>
      normalizeLookupKey(b.name) === normalizeLookupKey(name),
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

function createBookstackClient({ base, tokenId, tokenSecret }, log = () => {}) {
  const bsAuthHeader = `Token ${tokenId}:${tokenSecret}`;
  const context = { bookstackBase: base, bsAuthHeader, log };
  let pagesPromise;
  let booksPromise;
  const pageCache = new Map();

  function parseTarget(pageUrl) {
    const url = new URL(pageUrl);
    const root = new URL(base + "/");
    const prefix = root.pathname.replace(/\/+$/, "");
    if (url.origin !== root.origin || url.username || url.password || !url.pathname.startsWith(prefix + "/")) {
      throw new Error(`Ссылка BookStack относится к другому серверу: ${pageUrl}`);
    }
    const localPath = url.pathname.slice(prefix.length);
    const permalink = localPath.match(/^\/link\/([1-9]\d*)\/?$/);
    if (permalink) return { id: Number(permalink[1]) };
    const parsed = parseBookstackPageUrl(url.toString());
    if (!parsed || !/^\/books\/[^/]+\/page\/[^/]+\/?$/i.test(localPath)) throw new Error(`Некорректная ссылка BookStack: ${pageUrl}`);
    return parsed;
  }

  async function canonicalUrl(page) {
    booksPromise ||= listEntities("books");
    const book = (await booksPromise).find(item => Number(item.id) === Number(page.book_id));
    const bookSlug = book?.slug || page.book_slug;
    if (!bookSlug || !page.slug) throw new Error(`Не удалось получить URL BookStack page_id=${page.id}`);
    return `${base}/books/${encodeURIComponent(bookSlug)}/page/${encodeURIComponent(page.slug)}`;
  }

  async function getPage(id) {
    const key = Number(id);
    if (!Number.isSafeInteger(key) || key < 1) throw new Error("Некорректный BookStack ID");
    if (!pageCache.has(key)) pageCache.set(key, (async () => {
      const page = await fetchJson(`${base}/api/pages/${key}`, { headers: { Authorization: bsAuthHeader, Accept: "application/json" } });
      if (Number(page.id) !== key || page.draft) throw new Error(`Страница BookStack ${key} недоступна или является черновиком`);
      return { ...page, url: await canonicalUrl(page) };
    })());
    return pageCache.get(key);
  }

  async function listPages() {
    const pages = [];
    const count = 100;
    let offset = 0;
    for (;;) {
      const url = `${base}/api/pages?count=${count}&offset=${offset}`;
      const listing = await fetchJson(url, {
        headers: { Authorization: bsAuthHeader, Accept: "application/json" },
      });
      const items = Array.isArray(listing.data)
        ? listing.data
        : Array.isArray(listing.results) ? listing.results : [];
      pages.push(...items);
      offset += items.length;
      if (items.length < count) break;
      if (listing.total != null && offset >= listing.total) break;
    }
    return pages;
  }

  async function resolvePageId(pageUrl) {
    const parsed = parseTarget(pageUrl);
    if (parsed.id) return (await getPage(parsed.id)).id;
    pagesPromise ||= listPages();
    const pages = await pagesPromise;
    booksPromise ||= listEntities("books");
    const books = await booksPromise;
    const matches = pages.filter((page) => !page.draft &&
      normalizeLookupKey(page.book_slug || books.find(book => Number(book.id) === Number(page.book_id))?.slug) === normalizeLookupKey(decodeURIComponent(parsed.bookSlug)) &&
      normalizeLookupKey(page.slug) === normalizeLookupKey(decodeURIComponent(parsed.pageSlug)),
    );
    if (matches.length > 1) throw new Error(`Неоднозначная ссылка BookStack: ${pageUrl}`);
    return matches[0]?.id || null;
  }

  async function createPage(payload) {
    const page = await fetchJson(`${base}/api/pages`, {
      method: "POST",
      headers: {
        Authorization: bsAuthHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    pagesPromise = undefined;
    return page;
  }

  async function listEntities(entity) {
    const result = [];
    const count = 100;
    for (let offset = 0; ; offset += count) {
      const listing = await fetchJson(`${base}/api/${entity}?count=${count}&offset=${offset}`, {
        headers: { Authorization: bsAuthHeader, Accept: "application/json" },
      });
      const items = Array.isArray(listing.data) ? listing.data : [];
      result.push(...items);
      if (items.length < count || offset + items.length >= listing.total) return result;
    }
  }

  return {
    base,
    resolvePageId,
    getPage,
    canonicalUrl,
    validatePageUrl: parseTarget,
    permalink: id => `${base}/link/${id}`,
    createPage,
    listBooks: () => listEntities("books"),
    listChapters: () => listEntities("chapters"),
    updatePage: async (page) => {
      const updated = await updateBookstackPage({ ...context, ...page });
      if (Number(updated.id) !== Number(page.pageId)) throw new Error("BookStack вернул другой ID после обновления страницы");
      pageCache.delete(Number(page.pageId));
      pagesPromise = undefined;
      return updated;
    },
    findOrCreateBook: (desiredName) => findOrCreateBook({ ...context, desiredName }),
    uploadImage: (image) => uploadBookstackGalleryImage({ ...context, ...image }),
    deletePageImages: (pageId) =>
      deleteBookstackGalleryImagesForPage({ ...context, pageId }),
  };
}

module.exports = { createBookstackClient };
