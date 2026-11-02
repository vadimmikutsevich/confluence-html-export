export async function api(path, body) {
  const response = await fetch(`/api${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Ошибка запроса"), { status: response.status });
  return data;
}

export const isActive = job => job && ["running", "stopping"].includes(job.status);

export const modes = [
  { id: "export", title: "Выгрузить HTML", hint: "Сохранить документы в файлы. BookStack не изменяется." },
  { id: "sync", title: "Синхронизировать", hint: "Обновить существующие страницы по bookstack-config.yml." },
  { id: "import", title: "Создать страницы", hint: "Создать новые страницы в выбранной книге или главе." },
];
