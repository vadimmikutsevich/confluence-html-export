import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, isActive } from "./api.js";
import { TransferForm, initialForm } from "./TransferForm.jsx";
import { JobPanel } from "./JobPanel.jsx";
import "./styles.css";

function App() {
  const [form, setForm] = useState(initialForm);
  const [settings, setSettings] = useState(null);
  const [checked, setChecked] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState("connected");
  const [now, setNow] = useState(Date.now());
  const active = isActive(job);
  const validCheck = checked && checked.expires > now;
  const credentialsReady = settings?.confluenceReady && (form.mode === "export" || settings?.bookstackReady);

  async function initialize() {
    setError("");
    try {
      const [config, current] = await Promise.all([api("/settings"), api("/jobs/current")]);
      setSettings(config);
      setJob(current);
      setReady(true);
    } catch (error) { setError(error.message || "Локальный сервер недоступен"); }
  }
  useEffect(() => { initialize(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!job?.id || !active) return;
    const stream = new EventSource(`/api/jobs/${job.id}/events`);
    stream.onopen = () => setConnection("connected");
    stream.onmessage = event => { setJob(JSON.parse(event.data)); setConnection("connected"); };
    stream.onerror = async () => {
      setConnection("reconnecting");
      try { setJob(await api(`/jobs/${job.id}`)); }
      catch (error) {
        if (error.status === 404) {
          stream.close();
          setJob(previous => ({ ...previous, status: "interrupted" }));
          setChecked(null);
          setError("Сервер был перезапущен. Проверьте документы в BookStack перед новым переносом.");
        }
      }
    };
    return () => stream.close();
  }, [job?.id, active]);

  const changeForm = next => { setForm(next); setChecked(null); setError(""); };
  async function check() {
    setBusy("check"); setError(""); setChecked(null);
    try {
      const input = { ...form };
      if (input.mode !== "import") { delete input.bookId; delete input.chapterId; delete input.bookName; }
      setChecked(await api("/check", input));
      setNow(Date.now());
    } catch (error) { setError(error.message); }
    finally { setBusy(""); }
  }
  async function start() {
    setBusy("start"); setError("");
    try { setJob(await api("/jobs", { checkId: checked.id })); setChecked(null); }
    catch (error) { setError(error.message); }
    finally { setBusy(""); }
  }
  async function stop() {
    setBusy("stop"); setError("");
    try { setJob(await api(`/jobs/${job.id}/stop`, {})); }
    catch (error) { setError(error.message); }
    finally { setBusy(""); }
  }

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Перенос документации"><span className="brand-mark">↗</span><span>docs<span className="brand-light"> / transfer</span></span></a><span className="local-badge"><span className="status-dot" />Локальный инструмент</span></header>
    <main>
      <div className="hero"><div><div className="eyebrow">CONFLUENCE <span>→</span> BOOKSTACK</div><h1>Документы, на новом месте.</h1><p>Перенесите знания команды — со ссылками, якорями и изображениями.</p></div><div className="hero-index">01 <span>/ ПЕРЕНОС</span></div></div>
      <div className="connections">
        <div><span className={`status-dot ${settings?.confluenceReady ? "" : "missing"}`} /><strong>Confluence</strong><span>{settings?.confluenceBase || "Адрес из ссылки документа"}</span></div>
        <div><span className={`status-dot ${settings?.bookstackReady ? "" : "missing"}`} /><strong>BookStack</strong><span>{settings?.bookstackBase || "Не настроен"}</span></div>
        <span className="connection-caption">Настройки из .env · доступ проверяется перед запуском</span>
      </div>
      <div className="workspace">
        <section className="panel form-panel">
          <TransferForm form={form} onChange={changeForm} disabled={!ready || active || Boolean(busy)} settings={settings} />
          {!credentialsReady && ready && <div className="notice">Для этого режима заполните {settings?.confluenceReady ? "токены BookStack" : "CONFLUENCE_USER и CONFLUENCE_TOKEN"} в файле <code>.env</code> и перезапустите сервер. Секреты остаются на сервере.</div>}
          {checked && <div className={`check-result ${validCheck ? "" : "expired"}`} aria-live="polite">
            <strong>{validCheck ? `✓ Проверено документов: ${checked.documents.length}` : "Проверка устарела — выполните её снова"}</strong>
            <ul>{checked.documents.map(document => <li key={document.id}>{document.title || document.id}</li>)}</ul>
            <p className="help">{checked.confluenceBase}{checked.mode !== "export" && ` → ${checked.bookstackBase}`}</p>
            {checked.warnings.map((warning, index) => <p className="check-warning" key={index}>{warning}</p>)}
          </div>}
          {error && <div className="error-box" role="alert">{error}{!ready && <button className="text-button" onClick={initialize}>Подключиться снова</button>}</div>}
          <div className="form-actions">
            <button className={validCheck ? "secondary-button" : "primary-button"} disabled={!ready || !form.documents.trim() || !credentialsReady || active || Boolean(busy)} onClick={check}>{busy === "check" ? <><span className="spinner" />Проверяем доступ…</> : "Проверить документы"}</button>
            {validCheck && <button className="primary-button" onClick={start} disabled={active || Boolean(busy)}>{busy === "start" ? "Запускаем…" : "Запустить перенос"}<span>↗</span></button>}
          </div>
          <p className="action-note">{active ? "Параметры заблокированы на время выполнения задачи." : validCheck && form.mode !== "export" ? "Запуск внесёт изменения в BookStack. Очистка галереи работает как в CLI." : "Проверка документов не изменяет BookStack."}</p>
        </section>
        <JobPanel job={job} connection={connection} stop={stop} stopping={busy === "stop"} />
      </div>
      <footer><span>Сначала знания. Потом расстояния.</span><span>Confluence → BookStack <span className="footer-dot">·</span> Работает на вашем компьютере</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
