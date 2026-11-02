const Fastify = require("fastify");
const staticFiles = require("@fastify/static");
const path = require("node:path");
const fs = require("node:fs");
const { JobManager } = require("./jobs.cjs");
const { inputSchema, publicSettings, bookstackSettings } = require("./config.cjs");
const { createBookstackClient } = require("../../clients/bookstack.cjs");

async function buildApp({ env = process.env, port = 3000, manager = new JobManager(env) } = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts, "localhost:5173", "127.0.0.1:5173"].map(host => `http://${host}`));
  const streams = new Set();

  app.addHook("onRequest", async (request, reply) => {
    // Loopback binding alone does not protect a local API from hostile web pages.
    if (!hosts.has(request.headers.host) ||
        (request.headers.origin && !origins.has(request.headers.origin)) ||
        request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "Доступ разрешён только из локального интерфейса" });
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    else reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  });
  app.setErrorHandler((error, request, reply) => {
    reply.code(error.statusCode || 400).send({ error: manager.sanitize(error.message) });
  });

  app.get("/api/settings", async () => publicSettings(env));
  app.get("/api/destinations", async () => {
    const settings = bookstackSettings(env);
    if (!settings.base || !settings.tokenId || !settings.tokenSecret) throw new Error("Заполните BOOKSTACK_BASE и токены в .env, затем перезапустите сервер");
    const client = createBookstackClient(settings);
    const [books, chapters] = await Promise.all([client.listBooks(), client.listChapters()]);
    return {
      books: books.map(({ id, name }) => ({ id, name })),
      chapters: chapters.map(({ id, name, book_id }) => ({ id, name, bookId: book_id })),
    };
  });
  app.post("/api/check", { schema: { body: inputSchema } }, async request => manager.check(request.body));
  app.post("/api/jobs", { schema: { body: {
    type: "object", additionalProperties: false, required: ["checkId"],
    properties: { checkId: { type: "string", minLength: 1, maxLength: 100 } },
  } } }, async (request, reply) => reply.code(202).send(manager.start(request.body.checkId)));
  app.get("/api/jobs/current", async () => {
    const id = manager.active || [...manager.jobs.keys()].at(-1);
    return manager.snapshot(manager.jobs.get(id));
  });
  app.get("/api/jobs/:id", async request => {
    const job = manager.jobs.get(request.params.id);
    if (!job) throw Object.assign(new Error("Задача не найдена. Возможно, сервер был перезапущен."), { statusCode: 404 });
    return manager.snapshot(job);
  });
  app.post("/api/jobs/:id/stop", async request => manager.stop(request.params.id));
  app.get("/api/jobs/:id/files/:index", async (request, reply) => {
    const job = manager.jobs.get(request.params.id);
    const index = Number(request.params.index);
    const file = Number.isSafeInteger(index) && index >= 0 ? job?.files[index] : null;
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error("Файл недоступен"), { statusCode: 404 });
    reply.type("application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="document.html"; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    return reply.send(fs.createReadStream(file));
  });
  app.get("/api/jobs/:id/events", async (request, reply) => {
    const job = manager.jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Задача не найдена" });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive", "X-Content-Type-Options": "nosniff",
    });
    streams.add(response);
    const send = state => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    const listener = state => {
      // A slow client reconnects to a fresh snapshot instead of buffering forever.
      if (response.writableLength > 1_000_000) response.destroy();
      else send(state);
    };
    manager.events.on(job.id, listener);
    send(manager.snapshot(job));
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    response.on("close", () => {
      clearInterval(heartbeat);
      manager.events.off(job.id, listener);
      streams.delete(response);
    });
  });

  await app.register(staticFiles, { root: path.resolve(__dirname, "../dist"), index: "index.html" });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: "Не найдено. Соберите интерфейс: npm run web:build" }));
  app.addHook("preClose", async () => {
    for (const response of streams) response.end();
  });
  return { app, manager };
}

module.exports = { buildApp };
