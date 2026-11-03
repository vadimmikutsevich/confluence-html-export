const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { exportPages } = require("../../workflows/export.cjs");
const { syncPages } = require("../../workflows/sync.cjs");
const { importPage } = require("../../workflows/import-page.cjs");
const { checkpoint } = require("../../workflows/progress.cjs");
const { prepareInput } = require("./config.cjs");
const { prepareSyncPlan } = require("../../workflows/page-registry.cjs");

class JobManager {
  constructor(env, prepareContext = prepareInput) {
    this.env = env;
    this.prepareContext = prepareContext;
    this.checks = new Map();
    this.jobs = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.active = null;
    this.checking = false;
  }

  sanitize(value) {
    let text = String(value);
    // API responses can contain HTML and credentials; never send response bodies.
    text = text.split("\n")[0];
    for (const name of ["CONFLUENCE_TOKEN", "BOOKSTACK_TOKEN_SECRET", "BOOKSTACK_TOKEN_ID", "CONFLUENCE_USER"]) {
      const secret = this.env[name];
      if (secret) text = text.split(secret).join("[скрыто]");
    }
    return text.slice(0, 1000);
  }

  async check(input) {
    if (this.active || this.checking) throw Object.assign(new Error("Дождитесь завершения текущей операции"), { statusCode: 409 });
    this.checking = true;
    try {
      for (const [id, value] of this.checks) if (Date.now() > value.expires) this.checks.delete(id);
      if (this.checks.size >= 20) this.checks.delete(this.checks.keys().next().value);
      const context = this.prepareContext(input, this.env);
      const documents = [];
      const warnings = [];
      for (const root of context.roots) {
        const page = await context.confluence.getFullById(root.id);
        if (!page.html?.trim()) throw new Error(`Документ ${root.id} вернул пустой HTML`);
        documents.push({ id: root.id, title: page.title });
      }
      if (input.mode === "sync") {
        const plan = await prepareSyncPlan(documents, context, message => warnings.push(message));
        for (const page of documents) if (!plan.targets.has(String(page.id))) {
          warnings.push(`«${page.title}»: нет соответствия в bookstack-config.yml, страница будет пропущена`);
        }
      }
      if (input.mode === "import") {
        const books = await context.bookstack.listBooks();
        if (input.bookId && !books.some(book => book.id === input.bookId)) throw new Error("Выбранная книга недоступна");
        if (input.chapterId) {
          const chapters = await context.bookstack.listChapters();
          const chapter = chapters.find(item => item.id === input.chapterId);
          if (!chapter || (input.bookId && chapter.book_id !== input.bookId)) throw new Error("Выбранная глава недоступна в этой книге");
        }
      }
      if (input.recursive) warnings.push("Связанные страницы будут обнаруживаться во время запуска. Сейчас проверены только исходные документы.");
      if (input.mode !== "export") warnings.push("Проверка подтверждает чтение API. Право записи окончательно проверяется при сохранении страницы.");
      const id = randomUUID();
      const expires = Date.now() + 15 * 60_000;
      // Keep only the checked input; a run gets fresh clients and document HTML.
      this.checks.set(id, { input: { ...input }, expires });
      return { id, expires, documents, warnings, mode: input.mode, confluenceBase: context.config.confluenceBase, bookstackBase: context.config.bookstackBase };
    } finally {
      this.checking = false;
    }
  }

  start(checkId) {
    if (this.active || this.checking) throw Object.assign(new Error("Уже выполняется задача"), { statusCode: 409 });
    const checked = this.checks.get(checkId);
    if (!checked || Date.now() > checked.expires) throw new Error("Проверка устарела. Проверьте параметры ещё раз.");
    const context = this.prepareContext(checked.input, this.env);
    this.checks.delete(checkId);
    const id = randomUUID();
    const job = {
      id, mode: context.config.mode, status: "running", phase: "export",
      startedAt: new Date().toISOString(), finishedAt: null,
      loaded: 0, completed: 0, skipped: 0, failed: 0, imageFailures: 0, total: null,
      current: null, images: null, logs: [], results: [], files: [],
      controller: new AbortController(),
    };
    while (this.jobs.size >= 20) this.jobs.delete(this.jobs.keys().next().value);
    this.jobs.set(id, job);
    this.active = id;
    job.promise = this.run(job, context);
    return this.snapshot(job);
  }

  snapshot(job) {
    if (!job) return null;
    const { controller, promise, files, ...state } = job;
    return { ...state, files: files.map((file, index) => ({ name: path.basename(file), url: `/api/jobs/${job.id}/files/${index}` })) };
  }

  publish(job) {
    this.events.emit(job.id, this.snapshot(job));
  }

  log(job, message) {
    job.logs.push({ time: new Date().toISOString(), message: this.sanitize(message) });
    if (job.logs.length > 300) job.logs.shift();
    this.publish(job);
  }

  onEvent(job, event) {
    if (event.type === "phase") {
      job.phase = event.phase;
      job.total = event.total;
      job.current = null;
      job.images = null;
    } else if (event.type === "page.started") {
      job.current = { id: event.id, title: event.title || `Документ ${event.id}` };
      job.discovered = event.discovered ?? job.discovered;
      job.images = null;
    } else if (event.type === "page.loaded") job.loaded = event.loaded;
    else if (event.type === "images") job.images = { total: event.total, completed: event.completed };
    else if (event.type === "images.finished") job.imageFailures += event.failed;
    else if (event.type === "page.saved") job.files.push(event.file);
    else if (event.type === "page.created") {
      job.logs.push({ time: new Date().toISOString(), message: `Создана страница BookStack #${event.bookstackId}. Выполняется перенос изображений.` });
    } else if (event.type === "page.completed") {
      job.completed += 1;
      job.results.push({ id: event.id, title: event.title, url: event.url, status: "completed" });
    } else if (event.type === "page.skipped" || event.type === "page.failed") {
      job[event.type === "page.failed" ? "failed" : "skipped"] += 1;
      job.results.push({ id: event.id, title: event.title || event.id, status: "skipped", reason: event.reason });
    }
    this.publish(job);
  }

  async run(job, context) {
    const log = message => this.log(job, message);
    context = { ...context, signal: job.controller.signal, onEvent: event => this.onEvent(job, event), log };
    try {
      context.config = { ...context.config, outDir: path.join(context.config.outDir, job.id) };
      // Defer work until the task has been registered and the HTTP reply can be sent.
      await new Promise(resolve => setImmediate(resolve));
      if (job.mode === "import") {
        context.onEvent({ type: "phase", phase: "import", total: context.roots.length });
        for (const root of context.roots) {
          checkpoint(context.signal);
          await importPage({ ...context, config: { ...context.config, pageId: root.id, pageUrl: root.pageUrl } });
        }
      } else {
        const pages = await exportPages(context);
        checkpoint(context.signal);
        if (job.mode === "sync") await syncPages(pages, context, log);
        else {
          job.completed = pages.length;
          job.total = pages.length;
        }
      }
      job.status = job.controller.signal.aborted ? "stopped" : (job.failed || job.skipped || job.imageFailures ? "partial" : "completed");
      log(job.status === "stopped" ? "Остановка выполнена." : "Обработка завершена.");
    } catch (error) {
      if (error.name === "AbortError") job.status = "stopped";
      else { job.status = "failed"; job.failed += 1; }
      log(error.message);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.active = null;
      this.publish(job);
    }
  }

  stop(id) {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error("Задача не найдена"), { statusCode: 404 });
    if (this.active === id && !job.controller.signal.aborted) {
      job.controller.abort();
      job.status = "stopping";
      this.log(job, "Останавливаемся после текущей страницы. Уже сохранённые изменения останутся.");
    }
    return this.snapshot(job);
  }
}

module.exports = { JobManager };
