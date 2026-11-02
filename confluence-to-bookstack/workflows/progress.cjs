function checkpoint(signal) {
  if (signal?.aborted) {
    const error = new Error("Остановлено пользователем после завершения текущей операции");
    error.name = "AbortError";
    throw error;
  }
}

module.exports = { checkpoint };
