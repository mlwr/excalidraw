import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 5: AI usage (K2), libraries on the server (L1, L2), notifications
// (Z3), embedding links (T3).

export async function up(db: Kysely<any>): Promise<void> {
  // --- AI: requests and tokens per person, day and feature ----------------
  await db.schema
    .createTable("ai_usage")
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("day", "date", (col) => col.notNull())
    .addColumn("feature", "text", (col) => col.notNull())
    .addColumn("requests", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("prompt_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("completion_tokens", "bigint", (col) =>
      col.notNull().defaultTo(0),
    )
    .addPrimaryKeyConstraint("ai_usage_pk", ["user_id", "day", "feature"])
    .execute();
  await db.schema
    .createIndex("ai_usage_day_idx")
    .on("ai_usage")
    .column("day")
    .execute();

  // --- libraries: personal, per team collection, per workspace ---------------
  await db.schema
    .createTable("libraries")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("kind", "text", (col) =>
      col.notNull().check(sql`kind in ('personal', 'collection', 'workspace')`),
    )
    .addColumn("owner_id", "uuid", (col) =>
      col.references("users.id").onDelete("cascade"),
    )
    .addColumn("collection_id", "uuid", (col) =>
      col.references("collections.id").onDelete("cascade"),
    )
    .addColumn("workspace_id", "uuid", (col) =>
      col.references("workspaces.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    // items are encrypted like scenes: own key, sealed with the master key
    .addColumn("key_sealed", "bytea", (col) => col.notNull())
    .addColumn("content", "bytea")
    .addColumn("items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("size", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("revision", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("updated_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await sql`create unique index libraries_personal_idx on libraries (owner_id) where kind = 'personal'`.execute(
    db,
  );
  await db.schema
    .createIndex("libraries_collection_idx")
    .on("libraries")
    .column("collection_id")
    .execute();
  await db.schema
    .createIndex("libraries_workspace_idx")
    .on("libraries")
    .column("workspace_id")
    .execute();

  // --- notifications ----------------------------------------------------------
  await db.schema
    .createTable("notifications")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("actor_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("scene_id", "text", (col) =>
      col.references("scenes.id").onDelete("cascade"),
    )
    .addColumn("collection_id", "uuid", (col) =>
      col.references("collections.id").onDelete("cascade"),
    )
    .addColumn("thread_id", "uuid", (col) =>
      col.references("comment_threads.id").onDelete("cascade"),
    )
    // no content (comments are encrypted): ids and names of places only
    .addColumn("data", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("read_at", "timestamptz")
    .addColumn("email_state", "text", (col) =>
      col
        .notNull()
        .defaultTo("none")
        .check(sql`email_state in ('none', 'pending', 'sent', 'failed')`),
    )
    .execute();
  await db.schema
    .createIndex("notifications_user_idx")
    .on("notifications")
    .columns(["user_id", "id"])
    .execute();
  await sql`create index notifications_email_idx on notifications (id) where email_state = 'pending'`.execute(
    db,
  );

  await db.schema
    .createTable("user_preferences")
    .addColumn("user_id", "uuid", (col) =>
      col.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("preferences", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // --- embedding (T3) ----------------------------------------------------------
  await db.schema
    .alterTable("scenes")
    .addColumn("embed_token", "text")
    .execute();
  await sql`create unique index scenes_embed_token_idx on scenes (embed_token) where embed_token is not null`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("scenes").dropColumn("embed_token").execute();
  await db.schema.dropTable("user_preferences").execute();
  await db.schema.dropTable("notifications").execute();
  await db.schema.dropTable("libraries").execute();
  await db.schema.dropTable("ai_usage").execute();
}
