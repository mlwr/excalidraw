import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";

import * as m001 from "./migrations/001_initial.js";
import * as m002 from "./migrations/002_realtime_cluster.js";

import type { Database } from "./schema.js";
import type { Migration } from "kysely/migration";

// bigint (int8) columns: return them as strings, never lose precision
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => value);

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export const createDb = (connectionString: string, poolSize = 10): DbHandle => {
  const pool = new pg.Pool({ connectionString, max: poolSize });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    // Kysely ends the pool it was given
    close: () => db.destroy(),
  };
};

// Static list: the server is bundled into one file, so migrations cannot be
// discovered from the file system at runtime.
const MIGRATIONS: Record<string, Migration> = {
  "001_initial": m001,
  "002_realtime_cluster": m002,
};

export const migrateToLatest = async (db: Kysely<Database>) => {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => MIGRATIONS },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return (results || [])
    .filter((result) => result.status === "Success")
    .map((result) => result.migrationName);
};
