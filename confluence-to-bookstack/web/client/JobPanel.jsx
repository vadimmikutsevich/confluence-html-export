import React, { useEffect, useRef, useState } from "react";
import { isActive, modes } from "./api.js";

const statusNames = {
  running: "Выполняется", stopping: "Останавливается", stopped: "Остановлено",
  completed: "Готово", partial: "Завершено с замечаниями", failed: "Ошибка", interrupted: "Состояние недоступно",
};
const phaseNames = { export: "Загрузка документов", sync: "Обновление BookStack", import: "Создание страниц" };

function ResultLink({ result }) {
  const safeUrl = result.url && /^https?:\/\//i.test(result.url) ? result.url : null;
  return <div className="result-row">
    <span className={result.status === "completed" ? "success-text" : "muted"}>{result.status === "completed" ? "✓" : "—"}</span>
    <div>{safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer">{result.title} ↗</a> : <span>{result.title}</span>}{result.reason && <small>{result.reason}</small>}</div>
  </div>;
}

export function JobPanel({ job, connection, stop, stopping }) {
  const [follow, setFollow] = useState(true);
  const logBox = useRef(null);
  const active = isActive(job);
  const percent = job?.total ? Math.min(100, Math.round((job.completed + job.skipped) / job.total * 100)) : null;
  useEffect(() => {
    if (follow && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [job?.logs, follow]);

  if (!job) return <aside className="panel monitor empty-monitor">
    <div className="panel-title"><span className="eyebrow">ХОД ПЕРЕНОСА</span><span className="pill neutral">Ожидание</span></div>
    <div className="empty-visual" aria-hidden="true"><div className="paper back"><i /><i /><i /></div><div className="paper front"><i /><i /><i /><span>↗</span></div></div>
    <h2>Всё готово к переезду</h2>
    <p>Добавьте документы и проверьте параметры.<br />Здесь появятся прогресс, журнал и результат.</p>
    <div className="empty-steps"><span><b>1</b> Добавьте ссылки</span><span><b>2</b> Проверьте доступ</span><span><b>3</b> Запустите перенос</span></div>
    <div className="local-note"><span className="status-dot" />Задача выполняется локально. Вкладку можно обновлять.</div>
  </aside>;

  return <aside className="panel monitor">
    <div className="panel-title"><span className="eyebrow">ХОД ПЕРЕНОСА</span><span className={`pill ${job.status === "failed" ? "error-pill" : ""}`}>{statusNames[job.status]}</span></div>
    <div className="job-heading"><div><span className="help">{modes.find(mode => mode.id === job.mode)?.title}</span><h2>{active ? phaseNames[job.phase] : statusNames[job.status]}</h2></div><span className="percentage">{percent === null ? "…" : `${percent}%`}</span></div>
    <div className={`progress-track ${percent === null && active ? "indeterminate" : ""}`} role="progressbar" aria-label={phaseNames[job.phase]} aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent ?? undefined}>
      <div style={{ width: percent === null ? (active ? "35%" : "0%") : `${percent}%` }} />
    </div>
    <div className="progress-caption" aria-live="polite">
      <span>{job.phase === "export" && active ? `Загружено ${job.loaded} · найдено не менее ${job.discovered || job.loaded}` : `Обработано ${job.completed + job.skipped}${job.total === null ? "" : ` из ${job.total}`}`}</span>
      {connection === "reconnecting" && <span className="warning-text">Восстанавливаем связь…</span>}
    </div>
    {active && job.current && <div className="current-document"><span className="document-symbol">▤</span><div><strong>{job.current.title}</strong><small>{job.images?.total ? `Изображения: ${job.images.completed} из ${job.images.total}` : `Confluence ID: ${job.current.id}`}</small></div><span className="spinner" /></div>}
    <div className="stats"><div><strong>{job.completed}</strong><span>Готово</span></div><div><strong>{job.skipped}</strong><span>Пропущено</span></div><div><strong className={job.failed ? "error-text" : ""}>{job.failed}</strong><span>Ошибок страниц</span></div></div>
    {job.imageFailures > 0 && <p className="inline-error">Не удалось перенести изображений: {job.imageFailures}. Подробности в журнале.</p>}
    <div className="log-heading"><h3>Журнал</h3><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Автопрокрутка</label></div>
    <div className="log-box" ref={logBox} tabIndex="0" aria-label="Журнал выполнения">
      {job.logs.length ? job.logs.map((entry, index) => <div className="log-line" key={`${index}-${entry.time}`}><time>{new Date(entry.time).toLocaleTimeString("ru-RU")}</time><span className={/\[warn\]|ошиб|failed/i.test(entry.message) ? "log-warning" : ""}>{entry.message}</span></div>) : <span className="log-placeholder">Подготавливаем задачу…</span>}
    </div>
    {active ? <div className="stop-row"><button className="secondary-button" onClick={stop} disabled={stopping || job.status === "stopping"}>{job.status === "stopping" ? "Завершаем текущую страницу…" : "Остановить"}</button><p className="help">Уже сохранённые изменения останутся.</p></div>
      : <div className="result-section">
        {job.status === "failed" && <p className="inline-error">Часть изменений могла сохраниться. Проверьте журнал перед повторным запуском.</p>}
        {job.files.length > 0 && <details open={job.mode === "export"}><summary>HTML-файлы · {job.files.length}</summary><div className="result-list">{job.files.map(file => <a className="file-link" key={file.url} href={file.url} download>↓ <span>{file.name}</span></a>)}</div></details>}
        {job.results.length > 0 && <details open><summary>Документы · {job.results.length}</summary><div className="result-list">{job.results.map((result, index) => <ResultLink key={`${result.id}-${index}`} result={result} />)}</div></details>}
        <p className="help finished-time">{job.finishedAt ? `Завершено ${new Date(job.finishedAt).toLocaleTimeString("ru-RU")}` : "Состояние задачи потеряно после перезапуска сервера"}</p>
      </div>}
  </aside>;
}
