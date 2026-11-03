const { checkpoint } = require("./progress.cjs");

async function resolveSource(entry, confluence, expectedId) {
  let id = entry.confluence_id;
  if (!id) {
    const matches = await confluence.findPagesByTitle(entry.name);
    if (matches.length !== 1) throw new Error(`«${entry.name}»: найдено ${matches.length} страниц Confluence; укажите confluence_id вручную`);
    id = matches[0].id;
  }
  if (expectedId && String(id) !== String(expectedId)) throw new Error(`«${entry.name}»: Confluence ID не совпадает с выгружаемым документом`);
  const page = await confluence.getFullById(id);
  if (String(page.id) !== String(id) || !page.title) throw new Error(`Некорректный ответ Confluence для ${id}`);
  return page;
}

async function resolveTarget(entry, bookstack) {
  if (entry.link) {
    const parsed = bookstack.validatePageUrl(entry.link);
    if (parsed.id && entry.bookstack_id && Number(parsed.id) !== Number(entry.bookstack_id)) {
      throw new Error(`«${entry.name}»: link и bookstack_id относятся к разным страницам`);
    }
  }
  const id = entry.bookstack_id || (entry.link && await bookstack.resolvePageId(entry.link));
  if (!id) throw new Error(`«${entry.name}»: старый URL BookStack не найден; укажите bookstack_id вручную`);
  return bookstack.getPage(id);
}

function applyMapping(entry, source, target) {
  entry.confluence_id = String(source.id);
  entry.bookstack_id = Number(target.id);
  entry.name = source.title;
  entry.link = target.url;
}

// Read-only with respect to both APIs. Local config is saved only by the caller.
async function prepareSyncPlan(exported, { config, confluence, bookstack, signal }, log = console.log) {
  const registry = config.pageMap;
  registry.assertBases(confluence.base, bookstack.base);
  const sources = new Map(exported.map(page => [String(page.id), { ...page, title: page.sourceTitle || page.title }]));
  const wanted = new Set(sources.keys());
  for (const page of exported) for (const id of page.linkedIds || []) wanted.add(String(id));
  const targets = new Map();
  for (const id of wanted) {
    checkpoint(signal);
    let source = sources.get(id);
    let entry = registry.findById(id);
    if (!source) {
      try { source = await confluence.getFullById(id); }
      catch (error) {
        if (entry) throw new Error(`Confluence ${id}: не удалось проверить настроенную цель ссылки (${error.message.split("\n")[0]})`);
        log(`[warn] Не удалось прочитать ненастроенную Confluence-страницу ${id}`);
        continue;
      }
      sources.set(id, source);
    }
    entry ||= registry.findLegacy(source.title);
    if (!entry) continue;
    // Legacy names bootstrap identity only after a unique API-confirmed match.
    if (!entry.confluence_id) await resolveSource(entry, confluence, id);
    const target = await resolveTarget(entry, bookstack);
    applyMapping(entry, source, target);
    registry.validate();
    targets.set(id, { entry, page: target, url: bookstack.permalink(target.id) });
  }
  registry.setBases(confluence.base, bookstack.base);
  registry.render(); // Fail unsupported YAML edits before any gallery or page writes.
  return { registry, sources, targets };
}

async function migrateConfig({ config, confluence, bookstack, signal }, log = console.log) {
  const registry = config.pageMap;
  const release = registry.acquireRunLock();
  try {
    registry.assertBases(confluence.base, bookstack.base);
    const unresolved = [];
    const candidates = new Map();
    for (const entry of registry.entries) {
      checkpoint(signal);
      try {
        const source = await resolveSource(entry, confluence);
        const target = await resolveTarget(entry, bookstack);
        candidates.set(entry, { source, target });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        unresolved.push({ name: entry.name, reason: error.message.split("\n")[0] });
        log(`[unresolved] ${entry.name}: ${error.message.split("\n")[0]}`);
      }
    }
    const conflicts = new Set();
    for (const field of ["confluence_id", "bookstack_id"]) {
      const byId = new Map();
      for (const entry of registry.entries) {
        const resolved = candidates.get(entry);
        const id = resolved ? (field === "confluence_id" ? resolved.source.id : resolved.target.id) : entry[field];
        if (!id) continue;
        const group = byId.get(String(id)) || [];
        group.push(entry);
        byId.set(String(id), group);
      }
      for (const group of byId.values()) if (group.length > 1) for (const entry of group) conflicts.add(entry);
    }
    let migrated = 0;
    for (const [entry, { source, target }] of candidates) {
      if (conflicts.has(entry)) {
        const reason = "Несколько записей указывают на один ID; уточните соответствия вручную";
        unresolved.push({ name: entry.name, reason });
        log(`[unresolved] ${entry.name}: ${reason}`);
        continue;
      }
      applyMapping(entry, source, target);
      migrated++;
      log(`[map] ${source.id} → ${target.id}: ${source.title}`);
    }
    registry.setBases(confluence.base, bookstack.base);
    checkpoint(signal);
    if (config.dryRun) registry.render();
    else registry.save();
    log(`[map] ${config.dryRun ? "Проверено" : "Сохранено"}: ${migrated}, требуют проверки: ${unresolved.length}`);
    return { migrated, unresolved };
  } finally { release(); }
}

module.exports = { prepareSyncPlan, migrateConfig };
