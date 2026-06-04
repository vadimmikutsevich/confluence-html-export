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
          e && e.message ? e.message : e,
        )}${cause}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} при запросе ${url}\n${text.slice(0, 1200)}`,
      );
    }
    return await res.json();
  }
  throw lastErr || new Error(`Fetch failed for ${url}`);
}

module.exports = {
  fetchJson,
};
