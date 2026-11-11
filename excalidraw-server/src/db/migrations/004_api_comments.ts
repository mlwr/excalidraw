import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 3: personal API tokens (REST API, MCP server) and comments.
//
// Comment texts are encrypted with the scene's key, like the scene itself.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("api_tokens")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    // sha256 of the token; the token itself is shown once and never stored
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    // the last characters, so people can tell their tokens apart
    .addColumn("token_hint", "text", (col) => col.notNull())
    .addColumn("scope", "text", (col) =>
      col.notNull().check(sql`scope in ('read', 'write')`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_used_at", "timestamptz")
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("api_tokens_user_idx")
    .on("api_tokens")
    .column("user_id")
    .execute();

  await db.schema
    .createTable("comment_threads")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("scene_id", "text", (col) =>
      col.notNull().references("scenes.id").onDelete("cascade"),
    )
    // position in scene coordinates; relative to the element's top left
    // corner when the thread is pinned to an element
    .addColumn("x", "double precision", (col) => col.notNull())
    .addColumn("y", "double precision", (col) => col.notNull())
    .addColumn("element_id", "text")
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // last activity, for sorting
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("resolved_at", "timestamptz")
    .addColumn("resolved_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("deleted_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("comment_threads_scene_idx")
    .on("comment_threads")
    .columns(["scene_id", "created_at"])
    .execute();

  await db.schema
    .createTable("comments")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("thread_id", "uuid", (col) =>
      col.notNull().references("comment_threads.id").onDelete("cascade"),
    )
    .addColumn("author_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    // encrypted with the scene key
    .addColumn("body", "bytea", (col) => col.notNull())
    // people mentioned with @, for notifications later
    .addColumn("mentions", sql`uuid[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("edited_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("comments_thread_idx")
    .on("comments")
    .columns(["thread_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("comments").execute();
  await db.schema.dropTable("comment_threads").execute();
  await db.schema.dropTable("api_tokens").execute();
}
