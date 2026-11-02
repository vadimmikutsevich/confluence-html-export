function requireNonEmpty(value, message) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(message);
  }
  return value;
}

function validateConfig(config) {
  const required = [
    ["confluenceBase", "--confluence-base или CONFLUENCE_BASE"],
    ["confluenceUser", "--confluence-user или CONFLUENCE_USER"],
    ["confluenceToken", "--confluence-token или CONFLUENCE_TOKEN"],
  ];
  if (config.mode !== "export") {
    required.push(
      ["bookstackBase", "--bookstack-base или BOOKSTACK_BASE"],
      ["bookstackTokenId", "--bookstack-token-id или BOOKSTACK_TOKEN_ID"],
      ["bookstackTokenSecret", "--bookstack-token-secret или BOOKSTACK_TOKEN_SECRET"],
    );
  }
  for (const [name, source] of required) {
    requireNonEmpty(config[name], `Нужно указать ${source}`);
  }

  const minimums = { maxDepth: 0, concurrency: 1, maxBytes: 0 };
  for (const [name, minimum] of Object.entries(minimums)) {
    if (!Number.isSafeInteger(config[name]) || config[name] < minimum) {
      throw new Error(`Некорректный параметр ${name}: нужно целое число >= ${minimum}`);
    }
  }
  for (const name of ["bookId", "chapterId"]) {
    if (config[name] === undefined) continue;
    if (!Number.isSafeInteger(config[name]) || config[name] < 1) {
      throw new Error(`Некорректный параметр ${name}: нужно положительное целое число`);
    }
  }
  const bases = [config.confluenceBase];
  if (config.mode !== "export") bases.push(config.bookstackBase);
  for (const base of bases) {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("API URL должен использовать HTTP или HTTPS");
    }
  }
}

module.exports = { validateConfig };
