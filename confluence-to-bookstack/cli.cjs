#!/usr/bin/env node
/* eslint-disable no-console */

// Load .env (if present) from current working directory.
// This keeps secrets out of the repository while enabling convenient local runs.
require("dotenv").config({ quiet: true });

// DNS: verbatim = system order. Use for VPN/internal hosts (book.gambchamp.com).
// ipv4first can break resolution for internal hosts.
try {
  const dns = require("node:dns");
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("verbatim");
  }
} catch {
  // ignore
}

// Undici: family 0 = auto (IPv4+IPv6). For internal hosts via VPN.
try {
  const { Agent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(
    new Agent({
      connect: { family: 0 },
      connectTimeout: 30_000,
      headersTimeout: 30_000,
      bodyTimeout: 120_000,
    }),
  );
} catch {
  // ignore
}

const fs = require("node:fs");
const path = require("node:path");
const { Command } = require("commander");
const cheerio = require("cheerio");
const {
  uploadImagesToBookstackGalleryInHtml,
} = require("./lib/bookstack-image-gallery.cjs");
const Confluence = require("./lib/confluence.cjs");
const BookStack = require("./lib/bookstack.cjs");
const HtmlTransform = require("./lib/html-transform.cjs");
const Utils = require("./lib/utils.cjs");

const {
  basicAuthHeader,
  ensureDirSync,
  requireNonEmpty,
  sanitizeFilename,
} = Utils;
const {
  createConfluenceClient,
  deriveConfluenceBaseFromUrl,
  extractConfluencePageIdFromHref,
  extractConfluenceSpaceKeyFromUrl,
  parseConfluenceInput,
} = Confluence;
const { fetchJson } = require("./lib/http.cjs");
const {
  bookstackAuthHeader,
  findOrCreateBook,
  loadBookstackConfig,
  resolveBookstackPageIdFromUrl,
  updateBookstackPage,
} = BookStack;
const {
  humanizeConfluenceLinkText,
  normalizeAnchorsAndLinks,
  removeConfluencePageToc,
  removeConfluenceTinyImages,
  rewriteConfluenceLinksToBookstack,
  stripConfluenceNoise,
} = HtmlTransform;

async function main() {
  const program = new Command();
  program
    .name("confluence-to-bookstack")
    .description(
      "CLI: выгрузка страниц Confluence в HTML (и импорт в BookStack)",
    )
    .requiredOption("--page <urlOrId>", "URL страницы Confluence или pageId")
    .option(
      "--confluence-base <url>",
      "База Confluence, напр. https://site.atlassian.net/wiki",
    )
    .option(
      "--confluence-user <email>",
      "Confluence user/email (или env CONFLUENCE_USER)",
    )
    .option(
      "--confluence-token <token>",
      "Confluence API token (или env CONFLUENCE_TOKEN)",
    )
    .option(
      "--bookstack-base <url>",
      "База BookStack, напр. https://book.example.com",
    )
    .option(
      "--bookstack-token-id <id>",
      "BookStack token id (или env BOOKSTACK_TOKEN_ID)",
    )
    .option(
      "--bookstack-token-secret <secret>",
      "BookStack token secret (или env BOOKSTACK_TOKEN_SECRET)",
    )
    .option(
      "--book-id <id>",
      "BookStack book_id (если страница без главы)",
      (v) => (v ? Number(v) : v),
    )
    .option("--chapter-id <id>", "BookStack chapter_id", (v) =>
      v ? Number(v) : v,
    )
    .option(
      "--book-name <name>",
      "BookStack book name (будет найден/создан, если не указан book-id/chapter-id)",
    )
    .option("--title <name>", "Переопределить заголовок страницы в BookStack")
    .option(
      "--dry-run",
      "Не создавать страницу в BookStack, только вывести/сохранить HTML",
    )
    .option(
      "--out <file>",
      "Куда сохранить итоговый HTML (для dry-run или отладки)",
    )
    .option(
      "--out-dir <dir>",
      "Папка для сохранения HTML (default: ./confluence-export)",
      "confluence-export",
    )
    .option(
      "--recursive",
      "Рекурсивно выгружать Confluence-страницы, на которые есть ссылки",
    )
    .option(
      "--max-depth <n>",
      "Глубина рекурсии (default: 1)",
      (v) => Number(v),
      1,
    )
    .option(
      "--concurrency <n>",
      "Параллельные скачивания картинок (default: 4)",
      (v) => Number(v),
      4,
    )
    .option(
      "--max-bytes <n>",
      "Макс размер одной картинки в байтах (default: 15000000)",
      (v) => Number(v),
      15_000_000,
    )
    .option("--keep-ids", "Сохранить id атрибуты (по умолчанию удаляются)")
    .option(
      "--no-fragment",
      "Сохранять полный HTML (иначе сохраняется только фрагмент body)",
    )
    .option(
      "--config <path>",
      "Путь к bookstack-config.yml (карта page name -> link для синхронизации)",
    )
    .option(
      "--sync-bookstack",
      "Экспорт + обновление страниц в BookStack по конфигу (замена ссылок Confluence на BookStack)",
    )
    .parse(process.argv);

  const opts = program.opts();

  const { pageId, pageUrl } = parseConfluenceInput(opts.page);
  const confluenceUser = opts.confluenceUser || process.env.CONFLUENCE_USER;
  const confluenceToken = opts.confluenceToken || process.env.CONFLUENCE_TOKEN;
  requireNonEmpty(
    confluenceUser,
    "Нужно указать --confluence-user или env CONFLUENCE_USER",
  );
  requireNonEmpty(
    confluenceToken,
    "Нужно указать --confluence-token или env CONFLUENCE_TOKEN",
  );

  const confluenceBase =
    opts.confluenceBase ||
    (pageUrl ? deriveConfluenceBaseFromUrl(pageUrl) : null) ||
    process.env.CONFLUENCE_BASE;
  requireNonEmpty(
    confluenceBase,
    "Нужно указать --confluence-base (или env CONFLUENCE_BASE), если вы передаёте только pageId",
  );

  const confluenceAuthHeader = basicAuthHeader(confluenceUser, confluenceToken);
  const confluenceBaseNormalized = confluenceBase.replace(/\/+$/, "");

  const confluence = createConfluenceClient({
    confluenceBase: confluenceBaseNormalized,
    confluenceAuthHeader,
  });
  const { getFullById, getTitleById } = confluence;

  const renderCleanFragment = async ({ id, pageUrlForThis }) => {
    const page = await getFullById(id);
    const title =
      opts.title && String(opts.title).trim() && id === pageId
        ? String(opts.title).trim()
        : page.title || `Confluence page ${id}`;

    let html = page.html;
    requireNonEmpty(
      html,
      `Confluence вернул пустой body.export_view (pageId=${id})`,
    );

    html = `<div id="__root">${html}</div>`;

    const $ = cheerio.load(html, { decodeEntities: false });
    removeConfluenceTinyImages($);
    removeConfluencePageToc($);

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
      const pid = extractConfluencePageIdFromHref(
        href,
        confluenceBaseNormalized,
      );
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
    String(opts.outDir || "confluence-export"),
  );
  ensureDirSync(outDir);

  const makeOutPath = ({ title, id, isRoot }) => {
    if (isRoot && opts.out) return path.resolve(process.cwd(), opts.out);
    const safe = sanitizeFilename(title);
    // Keep title first, but ensure uniqueness by appending the id.
    return path.join(outDir, `${safe}__${id}.fragment.html`);
  };

  // Export (with optional recursion) when dry-run or sync-bookstack.
  let exported = [];
  if (opts.dryRun || opts.syncBookstack) {
    const visited = new Set();
    const queue = [{ id: String(pageId), depth: 0, pageUrlForThis: pageUrl }];

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const { id, depth, pageUrlForThis } = item;
      if (visited.has(id)) continue;
      visited.add(id);

      console.log(`[info] Export pageId=${id} depth=${depth}`);
      let res;
      try {
        res = await renderCleanFragment({ id, pageUrlForThis });
      } catch (e) {
        if (id === String(pageId)) throw e;
        console.warn(
          `[warn] Skip pageId=${id}: ${String(
            e && e.message ? e.message : e,
          )}`,
        );
        continue;
      }
      exported.push(res);

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
            queue.push({
              id: linkedId,
              depth: depth + 1,
              pageUrlForThis: null,
            });
          }
        }
      }
    }
  }

  // Sync to BookStack: rewrite links and update pages per config.
  if (opts.syncBookstack) {
    const log = (msg) => {
      console.log(msg);
    };

    const configPath =
      opts.config || path.resolve(process.cwd(), "bookstack-config.yml");
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Конфиг не найден: ${configPath}. Укажите --config <path> или положите bookstack-config.yml в корень проекта.`,
      );
    }
    const configByName = loadBookstackConfig(configPath);
    log(`[sync] Загружен конфиг: ${configPath} (${configByName.size} страниц)`);
    let idx = 0;
    for (const [name, link] of configByName) {
      if (idx++ < 5) log(`[sync]   конфиг: "${name}" -> ${link}`);
    }
    if (configByName.size > 5)
      log(`[sync]   ... и ещё ${configByName.size - 5} записей`);

    let bookstackBase = String(
      opts.bookstackBase || process.env.BOOKSTACK_BASE || "",
    ).replace(/\/+$/, "");
    if (!bookstackBase && configByName.size > 0) {
      const firstLink = configByName.values().next().value;
      if (firstLink) {
        try {
          bookstackBase = new URL(firstLink).origin;
          log(`[sync] BookStack base взят из конфига: ${bookstackBase}`);
        } catch {
          // ignore
        }
      }
    }
    requireNonEmpty(
      bookstackBase,
      "Для --sync-bookstack нужен --bookstack-base (или env BOOKSTACK_BASE), либо ссылки в конфиге",
    );
    log(`[sync] BookStack base: ${bookstackBase}`);

    const bsTokenId = opts.bookstackTokenId || process.env.BOOKSTACK_TOKEN_ID;
    const bsTokenSecret =
      opts.bookstackTokenSecret || process.env.BOOKSTACK_TOKEN_SECRET;
    requireNonEmpty(
      bsTokenId,
      "Для --sync-bookstack нужен --bookstack-token-id или env BOOKSTACK_TOKEN_ID",
    );
    requireNonEmpty(
      bsTokenSecret,
      "Для --sync-bookstack нужен --bookstack-token-secret или env BOOKSTACK_TOKEN_SECRET",
    );
    const bsAuthHeader = bookstackAuthHeader(bsTokenId, bsTokenSecret);

    const titleById = new Map();
    for (const r of exported) titleById.set(r.id, r.title);
    log(`[sync] Экспортировано страниц: ${exported.length}`);

    let updated = 0;
    let skipped = 0;
    for (const res of exported) {
      log(`[sync] --- Обработка: "${res.title}" (id=${res.id}) ---`);
      const link = configByName.get(res.title);
      if (!link) {
        log(`[skip] Нет в конфиге: "${res.title}"`);
        skipped += 1;
        continue;
      }
      log(`[sync] Есть в конфиге, link=${link}`);

      const pageIdBs = await resolveBookstackPageIdFromUrl({
        bookstackBase,
        bsAuthHeader,
        pageUrl: link,
        log,
      });
      if (!pageIdBs) {
        log(`[warn] Не найден page в BookStack: ${link}`);
        skipped += 1;
        continue;
      }
      log(`[sync] BookStack page_id=${pageIdBs}, переписываем ссылки...`);

      const $ = cheerio.load(res.html, { decodeEntities: false });
      rewriteConfluenceLinksToBookstack($, {
        titleById,
        configByName,
        confluenceBase: confluenceBaseNormalized,
      });
      const html = $("body").length
        ? $("body").html()
        : $("#__root").length
          ? $("#__root").html()
          : $.root().html();
      let htmlToSend = html || res.html;

      log(
        `[sync] Upload images to BookStack gallery for page_id=${pageIdBs}...`,
      );
      const galleryImages = await uploadImagesToBookstackGalleryInHtml(
        htmlToSend,
        {
          bookstackBase,
          bsAuthHeader,
          pageId: pageIdBs,
          confluenceBase: confluenceBaseNormalized,
          confluenceAuthHeader,
          concurrency: opts.concurrency,
          maxBytes: opts.maxBytes,
          log,
        },
      );
      htmlToSend = galleryImages.html || htmlToSend;
      log(
        `[sync] Images: uploaded=${galleryImages.stats.ok}, failed=${galleryImages.stats.fail}, skipped=${galleryImages.stats.skipped}`,
      );
      if (galleryImages.stats.fail > 0) {
        throw new Error(
          `Image gallery upload failed for ${galleryImages.stats.fail} image(s); skip BookStack page update.`,
        );
      }
      log(`[sync] Отправка HTML (${htmlToSend.length} символов)...`);

      await updateBookstackPage({
        bookstackBase,
        bsAuthHeader,
        pageId: pageIdBs,
        html: htmlToSend,
        name: res.title,
        log,
      });
      log(`[ok] Обновлена страница: "${res.title}" -> ${link}`);
      updated += 1;
    }
    log(`[sync] Итого: обновлено ${updated}, пропущено ${skipped}`);
    return;
  }

  if (opts.dryRun) {
    console.log("[info] Dry-run: skip BookStack create");
    return;
  }

  const bookstackBase = String(opts.bookstackBase || "").replace(/\/+$/, "");
  requireNonEmpty(
    bookstackBase,
    "Нужно указать --bookstack-base, чтобы создавать страницы в BookStack (или используйте --dry-run)",
  );

  const bsTokenId = opts.bookstackTokenId || process.env.BOOKSTACK_TOKEN_ID;
  const bsTokenSecret =
    opts.bookstackTokenSecret || process.env.BOOKSTACK_TOKEN_SECRET;
  requireNonEmpty(
    bsTokenId,
    "Нужно указать --bookstack-token-id или env BOOKSTACK_TOKEN_ID",
  );
  requireNonEmpty(
    bsTokenSecret,
    "Нужно указать --bookstack-token-secret или env BOOKSTACK_TOKEN_SECRET",
  );
  const bsAuthHeader = bookstackAuthHeader(bsTokenId, bsTokenSecret);

  // If target is not specified, ensure a BookStack book exists and use it.
  if (!opts.bookId && !opts.chapterId) {
    const derivedSpace = pageUrl
      ? extractConfluenceSpaceKeyFromUrl(pageUrl)
      : "";
    const desiredBookName =
      (opts.bookName && String(opts.bookName).trim()) ||
      (derivedSpace ? `Confluence: ${derivedSpace}` : "Confluence Imports");

    console.log(
      `[info] No target book/chapter provided. Ensuring book "${desiredBookName}"...`,
    );
    const book = await findOrCreateBook({
      bookstackBase,
      bsAuthHeader,
      desiredName: desiredBookName,
    });
    opts.bookId = book.id;
    console.log(
      `[info] Using book_id=${book.id} (${book.existed ? "found" : "created"})`,
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

  console.log(
    `[ok] Created BookStack page id=${created.id} name="${created.name}"`,
  );

  if (created.id) {
    console.log(
      `[info] Upload images to BookStack gallery for page_id=${created.id}...`,
    );
    const galleryImages = await uploadImagesToBookstackGalleryInHtml(
      rootRendered.html,
      {
        bookstackBase,
        bsAuthHeader,
        pageId: created.id,
        confluenceBase: confluenceBaseNormalized,
        confluenceAuthHeader,
        concurrency: opts.concurrency,
        maxBytes: opts.maxBytes,
        log: (msg) => console.log(msg),
      },
    );
    if (galleryImages.stats.ok || galleryImages.stats.fail) {
      await updateBookstackPage({
        bookstackBase,
        bsAuthHeader,
        pageId: created.id,
        html: galleryImages.html || rootRendered.html,
        name: rootRendered.title,
        log: (msg) => console.log(msg),
      });
    }
    console.log(
      `[info] Images: uploaded=${galleryImages.stats.ok}, failed=${galleryImages.stats.fail}, skipped=${galleryImages.stats.skipped}`,
    );
  }

  if (created.slug && created.book_slug) {
    console.log(
      `[ok] Likely URL: ${bookstackBase}/books/${created.book_slug}/page/${created.slug}`,
    );
  }
}

main().catch((e) => {
  console.error(`[error] ${String(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});
