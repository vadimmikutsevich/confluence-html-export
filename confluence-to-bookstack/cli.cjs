#!/usr/bin/env node
/* eslint-disable no-console */

// Load .env (if present) from current working directory.
// This keeps secrets out of the repository while enabling convenient local runs.
require("dotenv").config({ quiet: true });

// Prefer IPv4 first on Windows networks where IPv6 may be flaky.
// This helps avoid sporadic UND_ERR_CONNECT_TIMEOUT in Node's fetch (undici).
try {
  const dns = require("node:dns");
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
} catch {
  // ignore
}

// Also hint undici to use IPv4 if possible.
try {
  const { Agent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(
    new Agent({
      connect: { family: 4 },
      connectTimeout: 30_000,
      headersTimeout: 30_000,
      bodyTimeout: 120_000,
    })
  );
} catch {
  // ignore
}

const fs = require("node:fs");
const path = require("node:path");
const { Command } = require("commander");
const cheerio = require("cheerio");
const pLimitImport = require("p-limit");
const pLimit =
  typeof pLimitImport === "function" ? pLimitImport : pLimitImport.default;

function requireNonEmpty(value, message) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(message);
  }
  return value;
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

  // Typical Cloud URL: https://<site>.atlassian.net/wiki/spaces/<SPACE>/pages/<ID>/...
  const m = url.pathname.match(/\/pages\/(\d+)(?:\/|$)/);
  if (!m) {
    throw new Error(`Не смог извлечь pageId из URL: ${trimmed}`);
  }
  return { pageId: m[1], pageUrl: url.toString() };
}

function deriveConfluenceBaseFromUrl(pageUrl) {
  const url = new URL(pageUrl);
  // Confluence Cloud almost always lives under /wiki
  if (url.pathname.startsWith("/wiki")) return `${url.origin}/wiki`;
  return url.origin;
}

function extractConfluenceSpaceKeyFromUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const m = url.pathname.match(/\/spaces\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

function basicAuthHeader(user, token) {
  const raw = `${user}:${token}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function sanitizeFilename(input, { maxLen = 140 } = {}) {
  let s = String(input || "").normalize("NFKC").trim();
  // Replace forbidden chars on Windows + control chars.
  s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Windows: no trailing dot or space.
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

function extractConfluencePageIdFromHref(href, confluenceBase) {
  const raw = String(href || "").trim();
  if (!raw) return null;
  if (/^(mailto:|tel:|data:|#)/i.test(raw)) return null;

  const abs = absolutizeMaybe(raw, confluenceBase);
  try {
    const u = new URL(abs);
    const base = new URL(confluenceBase);
    if (u.origin !== base.origin) return null;
    const m = u.pathname.match(/\/pages\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, opts = {}) {
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
      const cause =
        e && e.cause
          ? `\nCause: ${e.cause.code || ""} ${e.cause.message || e.cause}`
          : "";
      throw new Error(
        `Fetch failed for ${url}\n${String(
          e && e.message ? e.message : e
        )}${cause}`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} при запросе ${url}\n${text.slice(0, 1200)}`
      );
    }
    return await res.json();
  }
  throw lastErr || new Error(`Fetch failed for ${url}`);
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
      const cause =
        e && e.cause
          ? `\nCause: ${e.cause.code || ""} ${e.cause.message || e.cause}`
          : "";
      throw new Error(
        `Fetch failed for ${url}\n${String(
          e && e.message ? e.message : e
        )}${cause}`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} при скачивании ${url}\n${text.slice(0, 600)}`
      );
    }
    const ct = res.headers.get("content-type") || "";
    const ab = await res.arrayBuffer();
    return { contentType: ct, bytes: Buffer.from(ab) };
  }
  throw lastErr || new Error(`Fetch failed for ${url}`);
}

function bookstackAuthHeader(tokenId, tokenSecret) {
  return `Token ${tokenId}:${tokenSecret}`;
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
        .toLowerCase() === name.toLowerCase()
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

function guessContentTypeByPathname(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.pathname.toLowerCase();
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
    if (p.endsWith(".gif")) return "image/gif";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".svg")) return "image/svg+xml";
    if (p.endsWith(".avif")) return "image/avif";
  } catch {
    // ignore
  }
  return "";
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

function looksLikeUrlText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (!/^https?:\/\//i.test(t)) return false;
  return true;
}

function normalizeAnchorsAndLinks(
  $,
  { pageUrl, pageId, confluenceBase, rewriteSelfLinks = true }
) {
  const preserveIds = new Set(["__root"]);
  let rewrittenSelfLinks = 0;

  const normalizeText = (text, { treatHyphenAsSpace } = {}) => {
    let t = String(text || "").trim().toLowerCase();
    if (!t) return "";
    if (treatHyphenAsSpace) t = t.replace(/-/g, " ");
    // normalize whitespace
    t = t.replace(/\s+/g, " ");
    // Replace punctuation with spaces so words don't get glued together.
    // This helps match "бонус-батчей" vs "бонус батчей" anchors reliably.
    t = t.replace(/[^\p{L}\p{N}]+/gu, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  };

  const normalizeHash = (hash) => {
    if (!hash) return "";
    let h = String(hash).trim();
    if (!h) return "";
    if (h.startsWith("#")) h = h.slice(1);
    try {
      // Keep Confluence's ids, but normalize encoding if any.
      h = decodeURIComponent(h);
    } catch {
      // ignore
    }
    // Confluence often includes trailing punctuation in autolinks.
    h = h.replace(/[.)\]]+$/g, "");
    return h;
  };

  const isSameConfluencePage = (hrefAbs) => {
    if (!hrefAbs) return false;
    try {
      const u = new URL(hrefAbs);
      // Match by pageId in pathname.
      return new RegExp(`/pages/${pageId}(?:/|$)`).test(u.pathname);
    } catch {
      return false;
    }
  };

  const getNiceAnchorText = (anchorToken) => {
    const token = String(anchorToken || "").trim();
    if (!token) return "";

    // Prefer actual element text if we can find the target.
    const byId = $(`[id="${token}"]`);
    if (byId && byId.length) {
      const t = String(byId.first().text() || "").trim();
      if (t) return t;
    }

    // Fallback: de-hyphenate the token (common for "pretty" anchors).
    const pretty = token.replace(/-/g, " ");
    return pretty;
  };

  // Rewrite self-links to local hashes, and collect targets.
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    if (!href) return;

    if (href.startsWith("#")) {
      const t = normalizeHash(href);
      if (t) preserveIds.add(t);
      return;
    }

    // Convert absolute (or relative) Confluence links to this same page into local anchors.
    const abs = absolutizeMaybe(href, confluenceBase);
    if (!rewriteSelfLinks) return;

    if (abs.includes("#") && isSameConfluencePage(abs)) {
      const u = new URL(abs);
      const t = normalizeHash(u.hash);
      if (t) {
        // Keep as raw token to avoid unreadable %D0... hashes in output.
        $(a).attr("href", `#${t}`);
        preserveIds.add(t);
        rewrittenSelfLinks += 1;

        // Confluence "smart links" often export with the URL as the visible text.
        // Replace that with a nicer human label (target heading text, if possible).
        const currentText = String($(a).text() || "").trim();
        const looksLikeUrl =
          /^https?:\/\//i.test(currentText) &&
          currentText.includes(`/pages/${pageId}`) &&
          currentText.includes("#");
        if (looksLikeUrl || currentText === abs || currentText === href) {
          const nice = getNiceAnchorText(t);
          if (nice) $(a).text(nice);
        }
      }
    }
  });

  // Build a map of headings by normalized text to an element.
  const headings = $("h1,h2,h3,h4,h5,h6").toArray();
  const headingByText = new Map();
  headings.forEach((h) => {
    const text = $(h).text();
    const key = normalizeText(text);
    if (!key) return;
    if (!headingByText.has(key)) headingByText.set(key, h);
    // Always preserve existing heading ids.
    const id = $(h).attr("id");
    if (id) preserveIds.add(String(id));
  });

  // If TOC links use Confluence id-... scheme, ensure the target heading gets that id.
  $('a[href^="#id-"]').each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    const desiredId = normalizeHash(href);
    const linkText = $(a).text();
    const key = normalizeText(linkText);
    if (!desiredId || !key) return;
    preserveIds.add(desiredId);

    const heading = headingByText.get(key);
    if (!heading) return;
    const currentId = $(heading).attr("id");
    if (!currentId) {
      $(heading).attr("id", desiredId);
    }
    preserveIds.add($(heading).attr("id"));
  });

  // Convert "pretty" Confluence anchors (often based on heading text) to the real heading id.
  // Example: href="#%D0%A2%D0%BE%D0%BF-%D0%B8%D0%B3%D1%80" -> match heading "Топ игр".
  $('a[href^="#"]').each((_, a) => {
    const href = String($(a).attr("href") || "").trim();
    if (!href || href.startsWith("#id-")) return;
    const decoded = normalizeHash(href);
    if (!decoded) return;

    const key = normalizeText(decoded, { treatHyphenAsSpace: true });
    if (!key) return;
    const heading = headingByText.get(key);
    if (!heading) return;

    // Ensure heading has an id.
    let hid = $(heading).attr("id");
    if (!hid) {
      // Prefer stable id- prefix if missing.
      hid = `id-${$(heading).text().trim().replace(/\s+/g, "")}`;
      $(heading).attr("id", hid);
    }
    preserveIds.add(hid);
    $(a).attr("href", `#${hid}`);
  });

  // Confluence sometimes uses name="..." anchors; convert them to ids so #... works.
  $("[name]").each((_, el) => {
    const name = String($(el).attr("name") || "").trim();
    if (!name) return;
    if (!$(el).attr("id")) $(el).attr("id", name);
    preserveIds.add(name);
  });

  // If there are preserveIds, ensure matching elements keep the id.
  return { preserveIds, rewrittenSelfLinks, pageUrl: pageUrl || null };
}

function stripConfluenceNoise($, { keepIds, preserveIds }) {
  // Remove scripts/styles/metadata that BookStack doesn't need.
  $("script, style, meta, link, noscript").remove();

  // Remove Confluence-specific attributes that only add noise.
  // Keep href/src, alt, title, colspan/rowspan, and a few accessibility attrs.
  const allowed = new Set([
    "href",
    "src",
    "alt",
    "title",
    "colspan",
    "rowspan",
    "target",
    "rel",
    "width",
    "height",
    "aria-label",
    "aria-hidden",
    "name",
  ]);

  $("*").each((_, el) => {
    const attribs = el.attribs || {};
    for (const [name] of Object.entries(attribs)) {
      if (name === "id" && attribs.id === "__root") continue; // internal wrapper
      if (name === "id" && keepIds) continue;
      if (name === "id" && preserveIds && preserveIds.has(attribs.id)) continue;
      if (name === "id" && !keepIds) {
        $(el).removeAttr("id");
        continue;
      }
      if (name === "class") {
        $(el).removeAttr("class");
        continue;
      }
      if (name.startsWith("data-")) {
        $(el).removeAttr(name);
        continue;
      }
      if (!allowed.has(name)) {
        // keep inline styles if present (часто они полезны для “похожести”)
        if (name === "style") continue;
        $(el).removeAttr(name);
      }
    }
  });
}

async function humanizeConfluenceLinkText(
  $,
  {
    currentPageId,
    confluenceBase,
    getTitleById,
    rewriteSamePageHrefToHash = true,
  }
) {
  const base = confluenceBase;
  const tasks = [];
  const limit = pLimit(6);

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = String($a.attr("href") || "").trim();
    if (!href) return;

    const linkedId = extractConfluencePageIdFromHref(href, base);
    if (!linkedId) return;

    tasks.push(
      limit(async () => {
        // If this is a same-page link with a hash, keep it as local #... (for BookStack friendliness).
        if (rewriteSamePageHrefToHash) {
          try {
            const abs = absolutizeMaybe(href, base);
            const u = new URL(abs);
            if (linkedId === String(currentPageId) && u.hash) {
              const h = decodeURIComponent(u.hash.replace(/^#/, ""));
              $a.attr("href", `#${h}`);
            }
          } catch {
            // ignore
          }
        }

        const text = $a.text();
        if (!looksLikeUrlText(text)) return;

        const title = await getTitleById(linkedId).catch(() => "");
        if (title) $a.text(title);
      })
    );
  });

  await Promise.all(tasks);
}

async function inlineImagesInHtml(
  html,
  { confluenceBase, confluenceAuthHeader, concurrency, maxBytes }
) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Make src/href absolute early so we can fetch.
  $("img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) $(img).attr("src", absolutizeMaybe(src, confluenceBase));
  });
  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (href) $(a).attr("href", absolutizeMaybe(href, confluenceBase));
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
        const src = String($(img).attr("src") || "").trim();
        if (!src) return;
        if (src.startsWith("data:")) {
          skipped += 1;
          return;
        }

        if (bySrc.has(src)) {
          $(img).attr("src", bySrc.get(src));
          ok += 1;
          return;
        }

        try {
          const u = new URL(src);
          const headers = {};
          if (u.origin === new URL(confluenceBase).origin) {
            headers.Authorization = confluenceAuthHeader;
          }

          const { contentType, bytes } = await fetchBinary(src, { headers });
          if (maxBytes && bytes.length > maxBytes) {
            throw new Error(
              `Слишком большой файл: ${bytes.length} bytes > ${maxBytes}`
            );
          }

          const ct =
            contentType.split(";")[0].trim() ||
            guessContentTypeByPathname(src) ||
            "application/octet-stream";
          const b64 = bytes.toString("base64");
          const dataUri = `data:${ct};base64,${b64}`;
          bySrc.set(src, dataUri);
          $(img).attr("src", dataUri);
          ok += 1;
        } catch (e) {
          fail += 1;
          // Keep original src on error.
          console.warn(
            `[warn] Не удалось встроить картинку: ${src}\n${String(
              e && e.message ? e.message : e
            )}`
          );
        }
      })
    )
  );

  return {
    html: $.root().html(),
    stats: { ok, fail, skipped, unique: bySrc.size },
  };
}

async function main() {
  const program = new Command();
  program
    .name("confluence-to-bookstack")
    .description("CLI: выгрузка страниц Confluence в HTML (и импорт в BookStack)")
    .requiredOption("--page <urlOrId>", "URL страницы Confluence или pageId")
    .option(
      "--confluence-base <url>",
      "База Confluence, напр. https://site.atlassian.net/wiki"
    )
    .option(
      "--confluence-user <email>",
      "Confluence user/email (или env CONFLUENCE_USER)"
    )
    .option(
      "--confluence-token <token>",
      "Confluence API token (или env CONFLUENCE_TOKEN)"
    )
    .option(
      "--bookstack-base <url>",
      "База BookStack, напр. https://book.example.com"
    )
    .option(
      "--bookstack-token-id <id>",
      "BookStack token id (или env BOOKSTACK_TOKEN_ID)"
    )
    .option(
      "--bookstack-token-secret <secret>",
      "BookStack token secret (или env BOOKSTACK_TOKEN_SECRET)"
    )
    .option(
      "--book-id <id>",
      "BookStack book_id (если страница без главы)",
      (v) => (v ? Number(v) : v)
    )
    .option("--chapter-id <id>", "BookStack chapter_id", (v) =>
      v ? Number(v) : v
    )
    .option(
      "--book-name <name>",
      "BookStack book name (будет найден/создан, если не указан book-id/chapter-id)"
    )
    .option("--title <name>", "Переопределить заголовок страницы в BookStack")
    .option(
      "--dry-run",
      "Не создавать страницу в BookStack, только вывести/сохранить HTML"
    )
    .option(
      "--out <file>",
      "Куда сохранить итоговый HTML (для dry-run или отладки)"
    )
    .option(
      "--out-dir <dir>",
      "Папка для сохранения HTML (default: ./confluence-export)",
      "confluence-export"
    )
    .option(
      "--recursive",
      "Рекурсивно выгружать Confluence-страницы, на которые есть ссылки"
    )
    .option(
      "--max-depth <n>",
      "Глубина рекурсии (default: 1)",
      (v) => Number(v),
      1
    )
    .option("--no-inline-images", "Не встраивать картинки (оставить ссылки)")
    .option(
      "--concurrency <n>",
      "Параллельные скачивания картинок (default: 4)",
      (v) => Number(v),
      4
    )
    .option(
      "--max-bytes <n>",
      "Макс размер одной картинки в байтах (default: 15000000)",
      (v) => Number(v),
      15_000_000
    )
    .option("--keep-ids", "Сохранить id атрибуты (по умолчанию удаляются)")
    .option(
      "--no-fragment",
      "Сохранять полный HTML (иначе сохраняется только фрагмент body)"
    )
    .parse(process.argv);

  const opts = program.opts();

  const { pageId, pageUrl } = parseConfluenceInput(opts.page);
  const confluenceUser = opts.confluenceUser || process.env.CONFLUENCE_USER;
  const confluenceToken = opts.confluenceToken || process.env.CONFLUENCE_TOKEN;
  requireNonEmpty(
    confluenceUser,
    "Нужно указать --confluence-user или env CONFLUENCE_USER"
  );
  requireNonEmpty(
    confluenceToken,
    "Нужно указать --confluence-token или env CONFLUENCE_TOKEN"
  );

  const confluenceBase =
    opts.confluenceBase ||
    (pageUrl ? deriveConfluenceBaseFromUrl(pageUrl) : null) ||
    process.env.CONFLUENCE_BASE;
  requireNonEmpty(
    confluenceBase,
    "Нужно указать --confluence-base (или env CONFLUENCE_BASE), если вы передаёте только pageId"
  );

  const confluenceAuthHeader = basicAuthHeader(confluenceUser, confluenceToken);
  const confluenceBaseNormalized = confluenceBase.replace(/\/+$/, "");

  // Cache for Confluence content (title only & full export).
  const titleCache = new Map(); // id -> Promise<string>
  const fullCache = new Map(); // id -> Promise<{id,title,html,spaceKey}>

  const getTitleById = (id) => {
    const key = String(id);
    if (titleCache.has(key)) return titleCache.get(key);
    const url = `${confluenceBaseNormalized}/rest/api/content/${key}`;
    const p = fetchJson(url, { headers: { Authorization: confluenceAuthHeader } })
      .then((j) => String(j.title || "").trim())
      .catch(() => "");
    titleCache.set(key, p);
    return p;
  };

  const getFullById = (id) => {
    const key = String(id);
    if (fullCache.has(key)) return fullCache.get(key);
    const url = `${confluenceBaseNormalized}/rest/api/content/${key}?expand=body.export_view,space,version`;
    const p = fetchJson(url, { headers: { Authorization: confluenceAuthHeader } })
      .then((j) => {
        const title = String(j.title || "").trim();
        const html =
          (j.body && j.body.export_view && j.body.export_view.value) || "";
        const spaceKey = j.space && j.space.key ? String(j.space.key) : "";
        return { id: key, title, html, spaceKey };
      })
      .catch((e) => {
        throw e;
      });
    fullCache.set(key, p);
    return p;
  };

  const renderCleanFragment = async ({ id, pageUrlForThis }) => {
    const page = await getFullById(id);
    const title =
      opts.title && String(opts.title).trim() && id === pageId
        ? String(opts.title).trim()
        : page.title || `Confluence page ${id}`;

    let html = page.html;
    requireNonEmpty(
      html,
      `Confluence вернул пустой body.export_view (pageId=${id})`
    );

    html = `<div id="__root">${html}</div>`;

    if (opts.inlineImages) {
      console.log(
        `[info] Inline images for ${id}... (concurrency=${opts.concurrency}, maxBytes=${opts.maxBytes})`
      );
      const inlined = await inlineImagesInHtml(html, {
        confluenceBase: confluenceBaseNormalized,
        confluenceAuthHeader,
        concurrency: opts.concurrency,
        maxBytes: opts.maxBytes,
      });
      html = inlined.html;
    }

    const $ = cheerio.load(html, { decodeEntities: false });

    // Improve link text (URL -> title) for Confluence page links.
    await humanizeConfluenceLinkText($, {
      currentPageId: id,
      confluenceBase: confluenceBaseNormalized,
      getTitleById,
      rewriteSamePageHrefToHash: true,
    });

    // Normalize anchors within page (self-links, pretty anchors, etc).
    const normalized = normalizeAnchorsAndLinks($, {
      pageUrl: pageUrlForThis || null,
      pageId: id,
      confluenceBase: confluenceBaseNormalized,
      rewriteSelfLinks: true,
    });

    // Collect linked page ids for recursion (after link normalization).
    const linkedIds = new Set();
    $("a[href]").each((_, a) => {
      const href = String($(a).attr("href") || "").trim();
      const pid = extractConfluencePageIdFromHref(href, confluenceBaseNormalized);
      if (pid && pid !== String(id)) linkedIds.add(pid);
    });

    stripConfluenceNoise($, {
      keepIds: Boolean(opts.keepIds),
      preserveIds: normalized.preserveIds,
    });

    if (opts.fragment) {
      const body = $("body");
      if (body.length) {
        html = body.html() || "";
      } else {
        const root = $("#__root");
        html = root.length ? root.html() : $.root().html();
      }
    } else {
      html = $.root().html();
    }

    return { id: String(id), title, html, linkedIds };
  };

  const outDir = path.resolve(
    process.cwd(),
    String(opts.outDir || "confluence-export")
  );
  ensureDirSync(outDir);

  const makeOutPath = ({ title, id, isRoot }) => {
    if (isRoot && opts.out) return path.resolve(process.cwd(), opts.out);
    const safe = sanitizeFilename(title);
    // Keep title first, but ensure uniqueness by appending the id.
    return path.join(outDir, `${safe}__${id}.fragment.html`);
  };

  // Export (with optional recursion) for dry-run scenarios.
  if (opts.dryRun) {
    const visited = new Set();
    const queue = [{ id: String(pageId), depth: 0, pageUrlForThis: pageUrl }];

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const { id, depth, pageUrlForThis } = item;
      if (visited.has(id)) continue;
      visited.add(id);

      console.log(`[info] Export pageId=${id} depth=${depth}`);
      const res = await renderCleanFragment({ id, pageUrlForThis });
      const outPath = makeOutPath({
        title: res.title,
        id: res.id,
        isRoot: id === String(pageId),
      });
      fs.writeFileSync(outPath, res.html, "utf8");
      console.log(`[info] Saved HTML: ${outPath}`);

      if (opts.recursive && depth < Number(opts.maxDepth || 1)) {
        for (const linkedId of res.linkedIds) {
          if (!visited.has(linkedId)) {
            queue.push({ id: linkedId, depth: depth + 1, pageUrlForThis: null });
          }
        }
      }
    }

    console.log("[info] Dry-run: skip BookStack create");
    return;
  }

  const bookstackBase = String(opts.bookstackBase || "").replace(/\/+$/, "");
  requireNonEmpty(
    bookstackBase,
    "Нужно указать --bookstack-base, чтобы создавать страницы в BookStack (или используйте --dry-run)"
  );

  const bsTokenId = opts.bookstackTokenId || process.env.BOOKSTACK_TOKEN_ID;
  const bsTokenSecret =
    opts.bookstackTokenSecret || process.env.BOOKSTACK_TOKEN_SECRET;
  requireNonEmpty(
    bsTokenId,
    "Нужно указать --bookstack-token-id или env BOOKSTACK_TOKEN_ID"
  );
  requireNonEmpty(
    bsTokenSecret,
    "Нужно указать --bookstack-token-secret или env BOOKSTACK_TOKEN_SECRET"
  );
  const bsAuthHeader = bookstackAuthHeader(bsTokenId, bsTokenSecret);

  // If target is not specified, ensure a BookStack book exists and use it.
  if (!opts.bookId && !opts.chapterId) {
    const derivedSpace = pageUrl ? extractConfluenceSpaceKeyFromUrl(pageUrl) : "";
    const desiredBookName =
      (opts.bookName && String(opts.bookName).trim()) ||
      (derivedSpace ? `Confluence: ${derivedSpace}` : "Confluence Imports");

    console.log(
      `[info] No target book/chapter provided. Ensuring book "${desiredBookName}"...`
    );
    const book = await findOrCreateBook({
      bookstackBase,
      bsAuthHeader,
      desiredName: desiredBookName,
    });
    opts.bookId = book.id;
    console.log(
      `[info] Using book_id=${book.id} (${book.existed ? "found" : "created"})`
    );
  }

  // Non dry-run mode: create single page (root only) in BookStack.
  const rootRendered = await renderCleanFragment({
    id: String(pageId),
    pageUrlForThis: pageUrl,
  });
  const payload = {
    name: rootRendered.title,
    html: rootRendered.html,
  };
  if (opts.chapterId) payload.chapter_id = opts.chapterId;
  if (opts.bookId) payload.book_id = opts.bookId;

  const createUrl = `${bookstackBase}/api/pages`;
  console.log(`[info] Create page: ${createUrl}`);
  const created = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Authorization: bsAuthHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  console.log(`[ok] Created BookStack page id=${created.id} name="${created.name}"`);
  if (created.slug && created.book_slug) {
    console.log(
      `[ok] Likely URL: ${bookstackBase}/books/${created.book_slug}/page/${created.slug}`
    );
  }
}

main().catch((e) => {
  console.error(`[error] ${String(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});

