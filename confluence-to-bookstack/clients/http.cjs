const RETRY_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
]);

async function request(url, options = {}, {
  attempts = 4,
  retryServerErrors = false,
  allowNotFound = false,
  log = () => {},
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (allowNotFound && response.status === 404) return response;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`HTTP ${response.status} for ${url}\n${body.slice(0, 1200)}`);
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      const retryable = RETRY_CODES.has(error.cause?.code) ||
        (retryServerErrors && (error.status >= 500 || /fetch failed/i.test(error.message)));
      if (!retryable || attempt >= attempts) throw error;
      const delay = 400 * 2 ** (attempt - 1);
      log(`[retry] ${options.method || "GET"} ${url}: ${attempt + 1}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function fetchJson(url, options, policy) {
  return (await request(url, options, policy)).json();
}

async function fetchBinary(url, options) {
  const response = await request(url, options);
  return {
    contentType: response.headers.get("content-type") || "",
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

async function fetchMaybeJson(url, options, policy) {
  const response = await request(url, options, policy);
  if (policy?.allowNotFound && response.status === 404) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { fetchJson, fetchBinary, fetchMaybeJson };
