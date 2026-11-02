const { fetchJson } = require("./http.cjs");
const {
  uploadBookstackGalleryImage,
  deleteBookstackGalleryImagesForPage,
} = require("./bookstack-gallery.cjs");

function parseBookstackPageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/books\/([^/]+)\/page\/([^/]+)/);
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

function createBookstackClient({ base, tokenId, tokenSecret }, log = () => {}) {
  const bsAuthHeader = `Token ${tokenId}:${tokenSecret}`;
  const context = { bookstackBase: base, bsAuthHeader, log };
  let pagesPromise;

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
    const parsed = parseBookstackPageUrl(pageUrl);
    if (!parsed) return null;
    pagesPromise ||= listPages();
    const pages = await pagesPromise;
    const match = pages.find((page) =>
      String(page.book_slug || "") === parsed.bookSlug &&
      String(page.slug || "") === parsed.pageSlug,
    );
    return match?.id || null;
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
    createPage,
    listBooks: () => listEntities("books"),
    listChapters: () => listEntities("chapters"),
    updatePage: (page) => updateBookstackPage({ ...context, ...page }),
    findOrCreateBook: (desiredName) => findOrCreateBook({ ...context, desiredName }),
    uploadImage: (image) => uploadBookstackGalleryImage({ ...context, ...image }),
    deletePageImages: (pageId) =>
      deleteBookstackGalleryImagesForPage({ ...context, pageId }),
  };
}

module.exports = { createBookstackClient };
