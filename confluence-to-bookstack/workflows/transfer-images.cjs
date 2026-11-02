const cheerio = require("cheerio");
const pLimitImport = require("p-limit");
const pLimit =
  typeof pLimitImport === "function" ? pLimitImport : pLimitImport.default;
const { absolutizeMaybe } = require("../shared/urls.cjs");
const {
  CONTENT_TYPE_EXTENSIONS,
  guessContentTypeByPathname,
  sanitizeImageName,
  imageNameFromUrl,
  parseDataUri,
  preferredBookstackImageUrl,
} = require("../shared/images.cjs");

async function transferImages(
  html,
  {
    bookstack,
    pageId,
    confluence,
    concurrency = 4,
    maxBytes = 15_000_000,
    log = () => {},
  },
) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const bookstackOrigin = new URL(bookstack.base).origin;
  const downloads = new Map();

  $("img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) $(img).attr("src", absolutizeMaybe(src, confluence.base));
  });

  const imgs = $("img").toArray();
  const limit = pLimit(concurrency);
  const bySrc = new Map();
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let deleted = 0;

  if (imgs.length > 0) {
    deleted = await bookstack.deletePageImages(pageId);
    if (deleted > 0) {
      log(`[images] deleted existing page gallery images: ${deleted}`);
    }
  }

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
            if (!downloads.has(src)) {
              downloads.set(src, confluence.downloadImage(src));
            }
            downloaded = await downloads.get(src);
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

          const uploaded = await bookstack.uploadImage({
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
    stats: { ok, fail, skipped, deleted, unique: bySrc.size },
  };
}

module.exports = { transferImages };
