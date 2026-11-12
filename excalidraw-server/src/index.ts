/* eslint-disable no-console -- CLI entry point: startup errors go to stderr before the logger exists */
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, migrateToLatest } from "./db/index.js";

const main = async () => {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  // `node server.mjs migrate`: run migrations and exit (e.g. as a Helm hook)
  if (process.argv[2] === "migrate") {
    const handle = createDb(config.databaseUrl, 1);
    try {
      const applied = await migrateToLatest(handle.db);
      console.log(
        applied.length
          ? `applied migrations: ${applied.join(", ")}`
          : "database is up to date",
      );
    } finally {
      await handle.close();
    }
    return;
  }

  const built = await buildApp(config);
  const { app } = built;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await built.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  if (config.metricsPort > 0) {
    await built.metrics.listen(config.host, config.metricsPort);
    app.log.info({ port: config.metricsPort }, "metrics listening on /metrics");
  }

  // warm up OIDC discovery; failures are logged and retried on first login
  built.ctx.oidc.ready().catch((error) => {
    app.log.warn(
      { err: error },
      "identity provider not reachable yet, will retry on first login",
    );
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
