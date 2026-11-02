const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
const { configureTransport } = require("../../clients/transport.cjs");
const { buildApp } = require("./app.cjs");

async function main() {
  configureTransport();
  const port = Number(process.env.WEB_PORT || 3000);
  const { app, manager } = await buildApp({ port });
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Открыть интерфейс: http://127.0.0.1:${port}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (manager.active) {
      const job = manager.jobs.get(manager.active);
      manager.stop(job.id);
      console.log("Завершаем текущую страницу перед остановкой сервера…");
      await job.promise;
    }
    await app.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
