import React, { useEffect, useState } from "react";
import { api, modes } from "./api.js";

export const initialForm = {
  documents: "", mode: "export", recursive: false, maxDepth: 1,
  concurrency: 4, maxBytesMb: 15, keepIds: false, fullHtml: false,
};

export function TransferForm({ form, onChange, disabled, settings }) {
  const [destinations, setDestinations] = useState(null);
  const [destinationError, setDestinationError] = useState("");
  const [loading, setLoading] = useState(false);
  const [newBook, setNewBook] = useState(false);
  const patch = changes => onChange({ ...form, ...changes });
  const lines = form.documents.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const unique = new Set(lines).size;

  async function loadDestinations() {
    setLoading(true);
    setDestinationError("");
    try { setDestinations(await api("/destinations")); }
    catch (error) { setDestinationError(error.message); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (form.mode === "import" && !destinations && settings?.bookstackReady) loadDestinations();
  }, [form.mode, settings?.bookstackReady]);

  return <fieldset disabled={disabled} className="form-fields">
    <div className="section-heading"><span className="step-number">01</span><h2>Документы</h2><span className="optional">Confluence</span></div>
    <label htmlFor="documents" className="field-label">Ссылки или ID страниц</label>
    <textarea id="documents" spellCheck="false" value={form.documents}
      onChange={event => patch({ documents: event.target.value })}
      placeholder={"https://company.atlassian.net/wiki/spaces/…/pages/12345\n67890"}
      aria-describedby="documents-help" />
    <div className="field-footer" id="documents-help"><span>По одному документу на строку</span><span>{unique ? `${unique} строк${lines.length !== unique ? " · повторы уберём" : ""}` : "Ссылки или числовые ID"}</span></div>

    <div className="section-heading separated"><span className="step-number">02</span><h2>Способ переноса</h2></div>
    <div className="mode-options" role="radiogroup" aria-label="Способ переноса">
      {modes.map(mode => <label className={`mode-option ${form.mode === mode.id ? "selected" : ""}`} key={mode.id}>
        <input type="radio" name="mode" value={mode.id} checked={form.mode === mode.id}
          onChange={() => patch({ mode: mode.id, recursive: mode.id === "import" ? false : form.recursive })} />
        <span>{mode.title}</span>
      </label>)}
    </div>
    <p className="help mode-hint">{modes.find(mode => mode.id === form.mode).hint}</p>

    {form.mode === "import" && <div className="destination-fields">
      <label className="check-row compact"><input type="checkbox" checked={newBook}
        onChange={event => { setNewBook(event.target.checked); patch({ bookId: undefined, chapterId: undefined, bookName: undefined }); }} />Указать книгу по имени</label>
      {newBook ? <label className="stack-label">Название книги<input value={form.bookName || ""} placeholder="Например, база знаний команды" onChange={event => patch({ bookName: event.target.value })} /></label>
        : <>
          <label className="stack-label">Книга<select value={form.bookId || ""} onChange={event => patch({ bookId: Number(event.target.value) || undefined, chapterId: undefined })}>
            <option value="">{loading ? "Загружаем книги…" : "Выберите книгу"}</option>
            {destinations?.books.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}
          </select></label>
          <label className="stack-label">Глава <span className="muted">необязательно</span><select value={form.chapterId || ""} disabled={!form.bookId || disabled} onChange={event => patch({ chapterId: Number(event.target.value) || undefined })}>
            <option value="">Без главы</option>
            {destinations?.chapters.filter(chapter => chapter.bookId === form.bookId).map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
          </select></label>
        </>}
      {destinationError && <p className="inline-error">{destinationError}</p>}
      {!newBook && <button type="button" className="text-button" onClick={loadDestinations} disabled={loading || disabled}>Обновить список книг</button>}
      <p className="help">Каждый запуск создаёт новые страницы. Связи между ними автоматически не переписываются.</p>
      {newBook && <p className="help">Если книга с таким именем уже есть, страницы попадут в неё. Иначе будет создана новая книга.</p>}
    </div>}

    <div className="options-block">
      <label className="check-row"><input type="checkbox" checked={form.recursive} disabled={form.mode === "import" || disabled} onChange={event => patch({ recursive: event.target.checked })} />
        <span><strong>Загрузить связанные документы</strong><small>{form.mode === "import" ? "Доступно для HTML и синхронизации" : "Перейти по ссылкам внутри исходных страниц"}</small></span>
      </label>
      {form.recursive && <label className="depth-row">Глубина переходов<input type="number" min="0" value={form.maxDepth} onChange={event => patch({ maxDepth: event.target.value === "" ? "" : Number(event.target.value) })} /><span className="help">0 — как 1, по правилам CLI</span></label>}
    </div>
    <details className="advanced">
      <summary>Дополнительные параметры</summary>
      <div className="two-columns">
        <label className="stack-label">Параллельных загрузок<input type="number" min="1" value={form.concurrency} onChange={event => patch({ concurrency: event.target.value === "" ? "" : Number(event.target.value) })} /></label>
        <label className="stack-label">Лимит изображения, МБ (0 — без лимита)<input type="number" min="0" value={form.maxBytesMb} onChange={event => patch({ maxBytesMb: event.target.value === "" ? "" : Number(event.target.value) })} /></label>
      </div>
      <label className="check-row compact"><input type="checkbox" checked={form.keepIds} onChange={event => patch({ keepIds: event.target.checked })} />Сохранять все HTML ID</label>
      <label className="check-row compact"><input type="checkbox" checked={form.fullHtml} onChange={event => patch({ fullHtml: event.target.checked })} />Полный HTML вместо фрагмента</label>
    </details>
  </fieldset>;
}
