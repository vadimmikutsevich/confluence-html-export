const { fetchJson, fetchMaybeJson } = require("./http.cjs");
const { CONTENT_TYPE_EXTENSIONS } = require("../shared/images.cjs");

async function uploadBookstackGalleryImage({
  bookstackBase,
  bsAuthHeader,
  pageId,
  name,
  contentType,
  bytes,
}) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!CONTENT_TYPE_EXTENSIONS.has(ct)) {
    throw new Error(`Unsupported BookStack image content type: ${ct || "empty"}`);
  }

  const form = new FormData();
  form.append("type", "gallery");
  form.append("uploaded_to", String(pageId));
  form.append("name", name);
  form.append("image", new Blob([bytes], { type: ct }), name);

  return await fetchJson(`${bookstackBase}/api/image-gallery`, {
    method: "POST",
    headers: {
      Authorization: bsAuthHeader,
      Accept: "application/json",
    },
    body: form,
  }, { attempts: 1 });
}

async function listBookstackGalleryImagesForPage({
  bookstackBase,
  bsAuthHeader,
  pageId,
  log,
}) {
  const images = [];
  const count = 100;

  for (let offset = 0; ; offset += count) {
    const url =
      `${bookstackBase}/api/image-gallery?count=${count}&offset=${offset}`;
    const json = await fetchJson(url, {
      headers: { Authorization: bsAuthHeader, Accept: "application/json" },
    }, { retryServerErrors: true, log });

    const data = Array.isArray(json.data) ? json.data : [];
    for (const image of data) {
      if (
        String(image.uploaded_to || "") === String(pageId) &&
        String(image.type || "") === "gallery"
      ) {
        images.push(image);
      }
    }

    const total = Number(json.total || 0);
    if (data.length < count) break;
    if (total > 0 && offset + data.length >= total) break;
  }

  return images;
}

async function deleteBookstackGalleryImage({
  bookstackBase,
  bsAuthHeader,
  id,
  log,
}) {
  await fetchMaybeJson(`${bookstackBase}/api/image-gallery/${id}`, {
    method: "DELETE",
    headers: { Authorization: bsAuthHeader, Accept: "application/json" },
  }, { allowNotFound: true, retryServerErrors: true, log });
}

async function deleteBookstackGalleryImagesForPage({
  bookstackBase,
  bsAuthHeader,
  pageId,
  log,
}) {
  const images = await listBookstackGalleryImagesForPage({
    bookstackBase,
    bsAuthHeader,
    pageId,
    log,
  });
  if (images.length === 0) return 0;

  log(`[images] deleting existing page gallery images: ${images.length}`);
  for (const image of images) {
    await deleteBookstackGalleryImage({
      bookstackBase,
      bsAuthHeader,
      id: image.id,
      log,
    });
  }

  return images.length;
}

module.exports = { uploadBookstackGalleryImage, deleteBookstackGalleryImagesForPage };
