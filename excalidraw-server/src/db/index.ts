import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";

import * as m001 from "./migrations/001_initial.js";
import * as m002 from "./migrations/002_realtime_cluster.js";
import * as m003 from "./migrations/003_workspace.js";
import * as m004 from "./migrations/004_api_comments.js";
import * as m005 from "./migrations/005_operations.js";
import * as m006 from "./migrations/006_operations_hardening.js";
import * as m007 from "./migrations/007_phase5.js";
import * as m008 from "./migrations/008_ai_usage_daily.js";

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
  "003_workspace": m003,
  "004_api_comments": m004,
  "005_operations": m005,
  "006_operations_hardening": m006,
  "007_phase5": m007,
  "008_ai_usage_daily": m008,
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
