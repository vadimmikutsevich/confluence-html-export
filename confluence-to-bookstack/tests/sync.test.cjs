const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const cheerio = require("cheerio");
const { loadBookstackConfig } = require("../config/page-map.cjs");
const { createBookstackClient } = require("../clients/bookstack.cjs");
const { createConfluenceClient } = require("../clients/confluence.cjs");
const { preparePage, finalizePage } = require("../html/pages.cjs");
const { stableAnchorId } = require("../html/stable-anchors.cjs");
const { prepareSyncPlan, migrateConfig } = require("../workflows/page-registry.cjs");
const { syncPages } = require("../workflows/sync.cjs");
const { JobManager } = require("../web/server/jobs.cjs");

const CF = "https://conf.example/wiki", BS = "https://book.example";
const silent = () => {};

function fixture(t, entries, raw) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c2b-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "map.yml");
  fs.writeFileSync(file, raw || yaml.dump({ books: [{ name: "Guide", pages: entries }] }));
  return { file, registry: () => loadBookstackConfig(file) };
}

function harness(t, { entries, sources, targets, raw }) {
  const files = fixture(t, entries, raw);
  const writes = [], galleries = [];
  const state = new Map(targets.map(page => [page.id, { book_id: 10, slug: `old-${page.id}`, html: "", ...page }]));
  let failId;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, BS);
    if (url.pathname === "/api/books") return Response.json({ data: [{ id: 10, slug: "guide" }, { id: 11, slug: "other-book" }], total: 2 });
    if (url.pathname === "/api/pages") return Response.json({ data: [...state.values()], total: state.size });
    const id = Number(url.pathname.split("/").at(-1));
    const page = state.get(id);
    if (!page) return new Response("not found", { status: 404 });
    if (options.method === "PUT") {
      if (id === failId) return new Response("forbidden", { status: 403 });
      const body = JSON.parse(options.body);
      writes.push({ id, ...body });
      page.slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      Object.assign(page, body);
    }
    return Response.json(page);
  };
  const confluence = {
    base: CF,
    getFullById: async id => {
      const page = sources.find(source => source.id === String(id));
      if (!page) throw new Error("source not found");
      return { ...page };
    },
    findPagesByTitle: async title => sources.filter(page => page.title.toLowerCase() === title.toLowerCase()),
    getTitleById: async id => sources.find(page => page.id === String(id))?.title || "",
    downloadImage: async () => ({ contentType: "image/png", bytes: Buffer.from("image") }),
  };
  const context = (options = {}) => {
    const bookstack = createBookstackClient({ base: BS, tokenId: "test", tokenSecret: "test" });
    bookstack.deletePageImages = async id => { galleries.push(id); return 2; };
    bookstack.uploadImage = async () => ({ url: BS + "/uploads/test.png" });
    return { config: { pageMap: files.registry(), configPath: files.file, mode: "sync", ...options }, confluence, bookstack };
  };
  const rendered = ids => ids.map(id => finalizePage(preparePage(
    sources.find(page => page.id === id), { confluenceBase: CF }, new Map(sources.map(page => [page.id, page.title])),
  ), { mode: "sync", fragment: true }));
  return { ...files, state, writes, galleries, context, rendered, fail: id => { failId = id; } };
}

test("YAML updates preserve comments, order, unknown fields, backup and repeated saves", t => {
  const raw = '# top comment\nbooks:\n  - name: "Guide"\n    pages:\n      - name: "Old # name" # keep me\n        link: "https://book.example/books/guide/page/old"\n        extra: value # custom\n';
  const f = fixture(t, null, raw), registry = f.registry();
  registry.setBases(CF, BS);
  Object.assign(registry.entries[0], { name: "New Name", confluence_id: "1", bookstack_id: 101 });
  registry.save();
  registry.entries[0].link = BS + "/books/guide/page/new-name";
  registry.save();
  const saved = fs.readFileSync(f.file, "utf8");
  assert.ok(saved.includes('# keep me'));
  assert.ok(saved.includes('extra: value # custom'));
  assert.ok(saved.includes('# top comment'));
  assert.equal(fs.readFileSync(f.file + ".bak", "utf8"), raw);
  assert.equal(f.registry().entries[0].name, "New Name");
  registry.save();
  assert.equal(fs.readFileSync(f.file, "utf8"), saved);
});

test("concurrent config edits and overlapping runs are rejected", t => {
  const f = fixture(t, [{ name: "A", link: BS + "/link/101" }]);
  const registry = f.registry();
  fs.appendFileSync(f.file, "# external edit\n");
  assert.throws(() => registry.save(), /другим процессом/);
  const release = registry.acquireRunLock();
  assert.throws(() => f.registry().acquireRunLock(), /уже выполняется/);
  release();
  assert.ok(fs.readFileSync(f.file, "utf8").includes("external edit"));
});

test("duplicate IDs are rejected, duplicate titles with explicit IDs are allowed", t => {
  assert.throws(() => fixture(t, [{ name: "A", confluence_id: "1", bookstack_id: 101 }, { name: "B", confluence_id: "1", bookstack_id: 102 }]).registry(), /Повторяющийся confluence_id/);
  assert.throws(() => fixture(t, [{ name: "A", confluence_id: "1", bookstack_id: 101 }, { name: "B", confluence_id: "2", bookstack_id: 101 }]).registry(), /Повторяющийся bookstack_id/);
  assert.equal(fixture(t, [{ name: "Same", confluence_id: "1", bookstack_id: 101 }, { name: "Same", confluence_id: "2", bookstack_id: 102 }]).registry().size, 2);
});

test("a dead process lock is automatically recovered and the next run is protected", t => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const deadPid = child.stdout.trim();
  assert.throws(() => process.kill(Number(deadPid), 0), { code: "ESRCH" });
  const f = fixture(t, [{ name: "A", link: BS + "/link/101" }]);
  fs.writeFileSync(f.file + ".sync.lock", deadPid);
  const release = f.registry().acquireRunLock();
  assert.equal(fs.readFileSync(f.file + ".sync.lock", "utf8"), String(process.pid));
  assert.throws(() => f.registry().acquireRunLock(), /уже выполняется/);
  release();
  release();
  assert.equal(fs.existsSync(f.file + ".sync.lock"), false);
  const releaseAgain = f.registry().acquireRunLock();
  releaseAgain();
});

test("releasing a lock never removes a replacement file", t => {
  const f = fixture(t, [{ name: "A", link: BS + "/link/101" }]);
  const release = f.registry().acquireRunLock();
  fs.unlinkSync(f.file + ".sync.lock");
  fs.writeFileSync(f.file + ".sync.lock", "replacement");
  release();
  assert.equal(fs.readFileSync(f.file + ".sync.lock", "utf8"), "replacement");
});

for (const order of [["1", "2"], ["2", "1"]]) test(`rename + cyclic links + anchors + repeat (${order.join(" → ")})`, async t => {
  const h = harness(t, {
    entries: [{ name: "Old A", confluence_id: "1", bookstack_id: 101, link: BS + "/books/guide/page/stale-a" }, { name: "Old B", confluence_id: "2", bookstack_id: 102, link: BS + "/books/guide/page/stale-b" }],
    sources: [{ id: "1", title: "New A", html: `<h2 id="A-Details">A</h2><a href="${CF}/pages/2#B-Details">B</a>` }, { id: "2", title: "New B", html: `<h2 id="B-Details">B</h2><a href="${CF}/pages/1#A-Details">A</a>` }],
    targets: [{ id: 101 }, { id: 102, book_id: 11 }],
  });
  await syncPages(h.rendered(order), h.context(), silent);
  await syncPages(h.rendered(order), h.context(), silent);
  assert.equal(h.writes.length, 4);
  assert.equal(cheerio.load(h.state.get(101).html)('a').attr('href'), BS + "/link/102#" + stableAnchorId("B-Details"));
  assert.equal(cheerio.load(h.state.get(102).html)('a').attr('href'), BS + "/link/101#" + stableAnchorId("A-Details"));
  assert.equal(h.registry().entries[1].link, BS + "/books/other-book/page/new-b");
  assert.equal(h.registry().entries[0].name, "New A");
  assert.deepEqual(h.galleries, []);
});

test("legacy case-insensitive mapping is migrated before the first write", async t => {
  const h = harness(t, { entries: [{ name: "UPPER NAME", link: BS + "/books/guide/page/old-101" }], sources: [{ id: "1", title: "Upper Name", html: "<p>Hello</p>" }], targets: [{ id: 101 }] });
  await syncPages(h.rendered(["1"]), h.context(), silent);
  assert.equal(h.registry().entries[0].confluence_id, "1");
  assert.equal(h.registry().entries[0].bookstack_id, 101);
  assert.equal(h.registry().entries[0].name, "Upper Name");
});

test("ambiguous legacy titles abort before page/gallery/config writes", async t => {
  const h = harness(t, { entries: [{ name: "Same", link: BS + "/link/101" }], sources: [{ id: "1", title: "Same", html: "<p>A</p>" }, { id: "2", title: "Same", html: "<p>B</p>" }], targets: [{ id: 101 }] });
  const before = fs.readFileSync(h.file, "utf8");
  await assert.rejects(syncPages(h.rendered(["1"]), h.context(), silent), /найдено 2/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.galleries.length, 0);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
});

test("dry-run and preflight perform no config/page/gallery writes", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "Renamed A", html: '<p><img src="https://conf.example/image.png"></p>' }], targets: [{ id: 101 }] });
  const before = fs.readFileSync(h.file, "utf8");
  await prepareSyncPlan(h.rendered(["1"]), h.context(), silent);
  await syncPages(h.rendered(["1"]), h.context({ dryRun: true }), silent);
  assert.equal(h.writes.length, 0);
  assert.equal(h.galleries.length, 0);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
});

test("partial failure resumes by persisted IDs after a successful rename", async t => {
  const h = harness(t, { entries: [{ name: "A", link: BS + "/link/101" }, { name: "B", link: BS + "/link/102" }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }, { id: "2", title: "B", html: "<p>B</p>" }], targets: [{ id: 101 }, { id: 102 }] });
  h.fail(102);
  await assert.rejects(syncPages(h.rendered(["1", "2"]), h.context(), silent), /403/);
  assert.ok(h.registry().entries.every(entry => entry.confluence_id && entry.bookstack_id));
  h.fail(undefined);
  await syncPages(h.rendered(["1", "2"]), h.context(), silent);
  assert.equal(h.writes.filter(write => write.id === 102).length, 1);
});

test("unexported targets use confirmed saved anchors; missing blocks fall back to page", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }, { name: "B", confluence_id: "2", bookstack_id: 102 }], sources: [{ id: "1", title: "A", html: `<a href="${CF}/pages/2#Details">B</a><a href="${CF}/pages/2#Missing">M</a>` }, { id: "2", title: "B", html: '<h2 id="Details">D</h2>' }], targets: [{ id: 101 }, { id: 102, html: `<h2 id="${stableAnchorId("Details")}">D</h2>` }] });
  const logs = [];
  await syncPages(h.rendered(["1"]), h.context(), message => logs.push(message));
  const $ = cheerio.load(h.state.get(101).html);
  assert.equal($('a').eq(0).attr('href'), BS + "/link/102#" + stableAnchorId("Details"));
  assert.equal($('a').eq(1).attr('href'), BS + "/link/102");
  assert.equal(h.writes.length, 1);
  assert.ok(logs.some(log => log.includes("Missing")));
});

test("unavailable mapped target aborts preflight; foreign server bindings are rejected", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 999 }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }], targets: [] });
  await assert.rejects(syncPages(h.rendered(["1"]), h.context(), silent), /404/);
  assert.equal(h.writes.length, 0);
  const context = h.context();
  context.config.pageMap.data.bookstack_base = "https://other.example";
  await assert.rejects(prepareSyncPlan(h.rendered(["1"]), context, silent), /другому серверу/);
  assert.throws(() => context.bookstack.validatePageUrl("https://other.example/link/101"), /другому серверу/);
});

test("image gallery cleanup and upload still run once before page update", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "A", html: '<p><img src="https://conf.example/image.png"></p>' }], targets: [{ id: 101 }] });
  await syncPages(h.rendered(["1"]), h.context(), silent);
  assert.deepEqual(h.galleries, [101]);
  assert.ok(h.writes[0].html.includes(BS + "/uploads/test.png"));
});

test("migration saves only unambiguous mappings and never modifies BookStack", async t => {
  const h = harness(t, { entries: [{ name: "A", link: BS + "/books/guide/page/old-101" }, { name: "Missing", link: BS + "/books/guide/page/missing" }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }], targets: [{ id: 101 }] });
  const result = await migrateConfig(h.context(), silent);
  assert.equal(result.migrated, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(h.registry().entries[0].bookstack_id, 101);
  assert.equal(h.registry().entries[1].confluence_id, undefined);
  assert.equal(h.writes.length, 0);
});

test("Confluence title search follows all cursor pages and refuses foreign pagination", async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async url => {
    calls++;
    assert.equal(new URL(url).origin, "https://conf.example");
    return Response.json({ results: [{ id: String(calls), title: "Same" }], _links: calls === 1 ? { next: "/rest/api/content/search?cursor=two" } : {} });
  };
  const client = createConfluenceClient({ base: CF, user: "test", token: "test" });
  assert.equal((await client.findPagesByTitle("SAME")).length, 2);
  global.fetch = async () => Response.json({ results: [], _links: { next: "https://other.example/rest/api/content/search" } });
  await assert.rejects(createConfluenceClient({ base: CF, user: "test", token: "test" }).findPagesByTitle("A"), /другой сервер/);
});

test("web preflight finds renamed ID-mapped documents without writing the config", async t => {
  const h = harness(t, { entries: [{ name: "Old Name", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "Renamed", html: "<p>A</p>" }], targets: [{ id: 101 }] });
  const before = fs.readFileSync(h.file, "utf8");
  const manager = new JobManager({}, () => ({ ...h.context(), roots: [{ id: "1" }] }));
  const result = await manager.check({ documents: "1", mode: "sync" });
  assert.equal(result.documents[0].title, "Renamed");
  assert.ok(!result.warnings.some(warning => warning.includes("нет соответствия")));
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  assert.equal(h.writes.length, 0);
});

test("migration leaves both conflicting legacy target mappings unresolved", async t => {
  const h = harness(t, { entries: [{ name: "A", link: BS + "/link/101" }, { name: "B", link: BS + "/link/101" }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }, { id: "2", title: "B", html: "<p>B</p>" }], targets: [{ id: 101 }] });
  const result = await migrateConfig(h.context(), silent);
  assert.equal(result.migrated, 0);
  assert.equal(result.unresolved.length, 2);
  assert.ok(h.registry().entries.every(entry => !entry.confluence_id && !entry.bookstack_id));
});

test("migration does not guess a BookStack target from a renamed title", async t => {
  const h = harness(t, { entries: [{ name: "A", link: BS + "/books/guide/page/outdated" }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }], targets: [{ id: 101, name: "A" }] });
  const result = await migrateConfig(h.context(), silent);
  assert.equal(result.migrated, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(h.registry().entries[0].bookstack_id, undefined);
});

test("image failure retains the existing cleanup semantics and prevents page PUT", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "A", html: '<p><img src="https://conf.example/image.png"></p>' }], targets: [{ id: 101 }] });
  const context = h.context();
  context.bookstack.uploadImage = async () => { throw new Error("upload failed"); };
  await assert.rejects(syncPages(h.rendered(["1"]), context, silent), /Image gallery upload failed/);
  assert.deepEqual(h.galleries, [101]);
  assert.equal(h.writes.length, 0);
  assert.equal(h.registry().entries[0].bookstack_id, 101);
});

test("stable anchors preserve exact Unicode/case fragments and local navigation", () => {
  const source = { id: "1", title: "A", html: '<h2 id="Раздел-A">Details</h2><p id="раздел-a">Other</p><a href="#%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB-A">Jump</a>' };
  const page = finalizePage(preparePage(source, { confluenceBase: CF }, new Map()), { mode: "sync", fragment: true });
  const $ = cheerio.load(page.html);
  assert.equal($('a').attr('href'), "#" + stableAnchorId("Раздел-A"));
  assert.notEqual(page.anchors.get("Раздел-A"), page.anchors.get("раздел-a"));
  assert.equal($('h2').attr('id'), stableAnchorId("Раздел-A"));
});

test("an incompatible BookStack HTML formatter is detected after saving", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "A", html: '<h2 id="Details">D</h2>' }], targets: [{ id: 101 }] });
  const context = h.context();
  const update = context.bookstack.updatePage;
  context.bookstack.updatePage = async payload => {
    const result = await update(payload);
    return { ...result, html: "<h2>Stripped</h2>" };
  };
  await assert.rejects(syncPages(h.rendered(["1"]), context, silent), /изменил стабильный якорь/);
  assert.equal(h.registry().entries[0].bookstack_id, 101);
});

test("cancelled runs release the lock and leave config/gallery/page unchanged", async t => {
  const h = harness(t, { entries: [{ name: "A", confluence_id: "1", bookstack_id: 101 }], sources: [{ id: "1", title: "A", html: "<p>A</p>" }], targets: [{ id: 101 }] });
  const controller = new AbortController();
  controller.abort();
  const before = fs.readFileSync(h.file, "utf8");
  await assert.rejects(syncPages(h.rendered(["1"]), { ...h.context(), signal: controller.signal }, silent), { name: "AbortError" });
  assert.equal(fs.existsSync(h.file + ".sync.lock"), false);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  assert.equal(h.writes.length, 0);
});
