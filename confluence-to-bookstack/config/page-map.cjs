const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const yaml = require("js-yaml");
const { normalizeLookupKey } = require("../shared/matching.cjs");

const PAGE_FIELDS = ["name", "link", "confluence_id", "bookstack_id"];
const BASE_FIELDS = ["confluence_base", "bookstack_base"];
const cleanBase = value => String(value || "").replace(/\/+$/, "");

function parseDocument(raw) {
  const stack = [];
  const nodes = new WeakMap();
  const data = yaml.load(raw, { listener(event, state) {
    if (event === "open") stack.push({ start: state.position, children: [] });
    else {
      const node = stack.pop();
      Object.assign(node, { end: state.position, kind: state.kind, value: state.result });
      if (node.value && typeof node.value === "object") nodes.set(node.value, node);
      if (stack.length) stack[stack.length - 1].children.push(node);
    }
  } });
  if (!data || !Array.isArray(data.books)) throw new Error("В конфиге ожидается массив books");
  const entries = data.books.flatMap(book => {
    if (!book || !Array.isArray(book.pages)) throw new Error("В каждой книге ожидается массив pages");
    return book.pages;
  });
  return { data, entries, nodes };
}

function positiveId(value, label) {
  const id = String(value ?? "");
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error(`Некорректный ${label}: ${id}`);
  return id;
}

class PageRegistry {
  constructor(configPath, raw = fs.readFileSync(configPath, "utf8")) {
    this.path = path.resolve(configPath);
    this.raw = raw;
    this.snapshot = parseDocument(raw);
    const working = parseDocument(raw);
    this.data = working.data;
    this.entries = working.entries;
    this.validate();
  }

  get size() { return this.entries.length; }
  *values() { for (const entry of this.entries) if (entry.link) yield entry.link; }

  validate() {
    const sourceIds = new Set(), targetIds = new Set(), objects = new Set();
    const legacyNames = new Set();
    for (const entry of this.entries) {
      if (!entry || typeof entry !== "object" || objects.has(entry)) throw new Error("Некорректная или повторно использованная YAML-запись страницы");
      objects.add(entry);
      if (!String(entry.name || "").trim() && !entry.confluence_id) throw new Error("У страницы нет name или confluence_id");
      if (!String(entry.link || "").trim() && !entry.bookstack_id) throw new Error(`У страницы «${entry.name}» нет link или bookstack_id`);
      for (const [field, seen] of [["confluence_id", sourceIds], ["bookstack_id", targetIds]]) {
        if (entry[field] == null) continue;
        const id = positiveId(entry[field], field);
        if (seen.has(id)) throw new Error(`Повторяющийся ${field}: ${id}`);
        seen.add(id);
      }
      if (!entry.confluence_id) {
        const key = normalizeLookupKey(entry.name);
        if (legacyNames.has(key)) throw new Error(`Неоднозначное имя без confluence_id: «${entry.name}»`);
        legacyNames.add(key);
      }
    }
  }

  findById(id) { return this.entries.find(entry => String(entry.confluence_id) === String(id)); }
  findLegacy(title) { return this.entries.find(entry => !entry.confluence_id && normalizeLookupKey(entry.name) === normalizeLookupKey(title)); }

  assertBases(confluenceBase, bookstackBase) {
    for (const [field, actual] of [["confluence_base", confluenceBase], ["bookstack_base", bookstackBase]]) {
      if (this.data[field] && cleanBase(this.data[field]) !== cleanBase(actual)) {
        throw new Error(`Конфиг привязан к другому серверу: ${field}=${this.data[field]}`);
      }
    }
  }

  setBases(confluenceBase, bookstackBase) {
    this.assertBases(confluenceBase, bookstackBase);
    this.data.confluence_base = cleanBase(confluenceBase);
    this.data.bookstack_base = cleanBase(bookstackBase);
  }

  acquireRunLock() {
    const lockPath = this.path + ".sync.lock";
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd;
      try { fd = fs.openSync(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const original = fs.statSync(lockPath);
          const pidText = fs.readFileSync(lockPath, "utf8").trim();
          const pid = Number(pidText);
          // An empty file may belong to a process still writing its PID.
          if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid) || pid > 2147483647) {
            throw new Error("Блокировка ещё не готова; повторите команду через несколько секунд");
          }
          try { process.kill(pid, 0); }
          catch (processError) {
            // EPERM is not evidence of a dead process.
            if (processError.code !== "ESRCH") throw new Error(`Для конфига уже выполняется синхронизация/миграция (PID ${pid})`);
            const current = fs.statSync(lockPath);
            if (current.dev === original.dev && current.ino === original.ino && fs.readFileSync(lockPath, "utf8").trim() === pidText) {
              fs.unlinkSync(lockPath);
            }
            continue;
          }
          throw new Error(`Для конфига уже выполняется синхронизация/миграция (PID ${pid})`);
        } catch (lockError) {
          if (lockError.code === "ENOENT") continue;
          throw lockError;
        }
      }
      const owned = fs.fstatSync(fd);
      const removeOwned = () => {
        try {
          const current = fs.statSync(lockPath);
          if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lockPath);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
      try { fs.writeFileSync(fd, String(process.pid)); }
      catch (error) {
        try { removeOwned(); } finally { fs.closeSync(fd); }
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { removeOwned(); } finally { fs.closeSync(fd); }
      };
    }
    throw new Error("Блокировка изменилась во время запуска; повторите команду");
  }

  render() {
    this.validate();
    const edits = [];
    const newline = this.raw.includes("\r\n") ? "\r\n" : "\n";
    const update = (original, current, fields, root = false) => {
      const node = this.snapshot.nodes.get(original);
      if (!node || this.raw.slice(node.start, node.start + 1) === "{") throw new Error("Для автообновления нужен YAML в блочном формате");
      const missing = [];
      for (const field of fields) {
        if (current[field] == null || current[field] === original[field]) continue;
        const index = node.children.findIndex((child, index) => index % 2 === 0 && child.kind === "scalar" && child.value === field);
        if (index >= 0) {
          const value = node.children[index + 1];
          if (!value || value.kind !== "scalar") throw new Error(`Ожидается простое значение ${field}`);
          edits.push({ start: value.start, end: value.end, text: ` ${JSON.stringify(current[field])}` });
        } else missing.push(`${field}: ${JSON.stringify(current[field])}`);
      }
      if (missing.length) {
        if (root) edits.push({ start: 0, end: 0, text: missing.join(newline) + newline });
        else {
          const indent = " ".repeat(node.start - this.raw.lastIndexOf("\n", node.start - 1) - 1);
          const end = node.end - (this.raw.slice(0, node.end).match(/[ \t]*$/)?.[0].length || 0);
          const prefix = this.raw[end - 1] === "\n" ? "" : newline;
          edits.push({ start: end, end, text: prefix + missing.map(line => indent + line).join(newline) + newline });
        }
      }
    };
    update(this.snapshot.data, this.data, BASE_FIELDS, true);
    this.entries.forEach((entry, index) => update(this.snapshot.entries[index], entry, PAGE_FIELDS));
    let output = this.raw;
    for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    const parsed = parseDocument(output);
    for (const field of BASE_FIELDS) {
      if (parsed.data[field] !== this.data[field]) throw new Error(`Не удалось безопасно обновить ${field} в YAML`);
    }
    this.entries.forEach((entry, index) => {
      for (const field of PAGE_FIELDS) {
        if (parsed.entries[index]?.[field] !== entry[field]) throw new Error(`Не удалось безопасно обновить ${field} в YAML`);
      }
    });
    return output;
  }

  save() {
    const next = this.render();
    const lockPath = this.path + ".lock";
    let lock;
    let temp;
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
      if (fs.readFileSync(this.path, "utf8") !== this.raw) throw new Error("Конфиг изменён другим процессом; повторите запуск");
      if (next === this.raw) return;
      try { fs.writeFileSync(this.path + ".bak", this.raw, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      temp = this.path + `.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, "wx", fs.statSync(this.path).mode & 0o777);
      try { fs.writeFileSync(fd, next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.path);
      this.raw = next;
      this.snapshot = parseDocument(next);
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
    }
  }
}

function loadBookstackConfig(configPath) { return new PageRegistry(configPath); }

module.exports = { loadBookstackConfig, PageRegistry, positiveId };
