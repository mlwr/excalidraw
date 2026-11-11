import { sql } from "kysely";

import type { Kysely } from "kysely";

// Migrations receive an untyped Kysely instance on purpose: the typed schema
// describes the latest state, a migration describes one step towards it.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Phase 2 adds collections, scenes and members on top of workspaces. The
  // default workspace exists from the start so data never needs re-homing.
  await db
    .insertInto("workspaces")
    .values({ slug: "default", name: "Workspace" })
    .execute();

  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("oidc_issuer", "text", (col) => col.notNull())
    .addColumn("oidc_subject", "text", (col) => col.notNull())
    .addColumn("email", "text")
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("username", "text")
    .addColumn("roles", sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'::text[]`),
    )
    .addColumn("groups", sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'::text[]`),
    )
    .addColumn("is_admin", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_login_at", "timestamptz")
    .addColumn("disabled_at", "timestamptz")
    .addUniqueConstraint("users_oidc_identity_unique", [
      "oidc_issuer",
      "oidc_subject",
    ])
    .execute();

  await db.schema
    .createTable("sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("oidc_sid", "text")
    .addColumn("id_token", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_seen_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("user_agent", "text")
    .execute();
  await db.schema
    .createIndex("sessions_user_id_idx")
    .on("sessions")
    .column("user_id")
    .execute();
  await db.schema
    .createIndex("sessions_oidc_sid_idx")
    .on("sessions")
    .column("oidc_sid")
    .execute();
  await db.schema
    .createIndex("sessions_expires_at_idx")
    .on("sessions")
    .column("expires_at")
    .execute();

  await db.schema
    .createTable("login_states")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("nonce", "text", (col) => col.notNull())
    .addColumn("code_verifier", "text", (col) => col.notNull())
    .addColumn("return_to", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("rooms")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workspace_id", "uuid", (col) =>
      col.references("workspaces.id").onDelete("cascade"),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("scene_version", "bigint", (col) => col.notNull())
    .addColumn("revision", "bigint", (col) => col.notNull().defaultTo(1))
    .addColumn("iv", "bytea", (col) => col.notNull())
    .addColumn("ciphertext", "bytea", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("share_links")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("payload", "bytea", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("blobs")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("data", "bytea", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("content_type", "text")
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    "blobs",
    "share_links",
    "rooms",
    "login_states",
    "sessions",
    "users",
    "workspaces",
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
