import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 4: several workspaces with members and policies, trash, version
// history, search index, events (activity feed and audit log), settings.

export async function up(db: Kysely<any>): Promise<void> {
  // --- workspaces: members, policies ------------------------------------------
  await db.schema
    .alterTable("workspaces")
    // the default workspace: everybody who may use the app is a member
    .addColumn("open_to_all", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    // policies (T5): see workspace/policies.ts
    .addColumn("settings", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("deleted_at", "timestamptz")
    .execute();
  await db
    .updateTable("workspaces")
    .set({ open_to_all: true, name: "Allgemein" })
    .where("slug", "=", "default")
    .execute();

  await db.schema
    .createTable("workspace_members")
    .addColumn("workspace_id", "uuid", (col) =>
      col.notNull().references("workspaces.id").onDelete("cascade"),
    )
    .addColumn("principal_type", "text", (col) =>
      col.notNull().check(sql`principal_type in ('user', 'group')`),
    )
    .addColumn("principal", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) =>
      col.notNull().check(sql`role in ('member', 'admin')`),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("workspace_members_pk", [
      "workspace_id",
      "principal_type",
      "principal",
    ])
    .execute();

  // a personal collection per person and workspace
  await sql`drop index collections_personal_owner_idx`.execute(db);
  await sql`create unique index collections_personal_owner_idx on collections (workspace_id, owner_id) where kind = 'personal'`.execute(
    db,
  );

  // --- trash ---------------------------------------------------------------------
  await db.schema
    .alterTable("scenes")
    .addColumn("deleted_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .execute();

  // --- version history (encrypted like the scene itself) --------------------
  await db.schema
    .createTable("scene_versions")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("scene_id", "text", (col) =>
      col.notNull().references("scenes.id").onDelete("cascade"),
    )
    // when this state of the scene was saved
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // when the version was taken (at most one per interval)
    .addColumn("taken_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("revision", "bigint", (col) => col.notNull())
    .addColumn("scene_version", "bigint", (col) => col.notNull())
    .addColumn("iv", "bytea", (col) => col.notNull())
    .addColumn("ciphertext", "bytea", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("reason", "text", (col) =>
      col
        .notNull()
        .defaultTo("auto")
        .check(sql`reason in ('auto', 'restore', 'import')`),
    )
    .execute();
  await sql`create index scene_versions_scene_idx on scene_versions (scene_id, created_at desc)`.execute(
    db,
  );

  // --- search index: keyed hashes of words, not the words themselves -----------
  await db.schema
    .createTable("scene_search")
    .addColumn("scene_id", "text", (col) =>
      col.primaryKey().references("scenes.id").onDelete("cascade"),
    )
    .addColumn("tokens", sql`bigint[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'`),
    )
    // -1: re-index (e.g. comments changed)
    .addColumn("indexed_revision", "bigint", (col) =>
      col.notNull().defaultTo(-1),
    )
    .addColumn("indexed_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await sql`create index scene_search_tokens_idx on scene_search using gin (tokens)`.execute(
    db,
  );

  // --- events: activity feed and audit log ------------------------------------
  await db.schema
    .createTable("events")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("actor_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    // name at the time, so the log stays readable
    .addColumn("actor_name", "text")
    .addColumn("type", "text", (col) => col.notNull())
    // no foreign keys: events outlive what they are about
    .addColumn("workspace_id", "uuid")
    .addColumn("collection_id", "uuid")
    .addColumn("scene_id", "text")
    .addColumn("target", "text")
    .addColumn("data", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("ip", "text")
    .addColumn("user_agent", "text")
    .execute();
  for (const [name, columns] of [
    ["events_at_idx", "at desc"],
    ["events_scene_idx", "scene_id, at desc"],
    ["events_collection_idx", "collection_id, at desc"],
    ["events_workspace_idx", "workspace_id, at desc"],
    ["events_actor_idx", "actor_id, at desc"],
    ["events_type_idx", "type, at desc"],
  ]) {
    await sql.raw(`create index ${name} on events (${columns})`).execute(db);
  }

  // --- global settings (branding) -----------------------------------------------
  await db.schema
    .createTable("settings")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("value", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .execute();

  // --- people removed for data protection reasons (S3) --------------------------
  await db.schema
    .alterTable("users")
    .addColumn("erased_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("erased_at").execute();
  await db.schema.dropTable("settings").execute();
  await db.schema.dropTable("events").execute();
  await db.schema.dropTable("scene_search").execute();
  await db.schema.dropTable("scene_versions").execute();
  await db.schema.alterTable("scenes").dropColumn("deleted_by").execute();
  await sql`drop index collections_personal_owner_idx`.execute(db);
  await sql`create unique index collections_personal_owner_idx on collections (owner_id) where kind = 'personal'`.execute(
    db,
  );
  await db.schema.dropTable("workspace_members").execute();
  await db.schema
    .alterTable("workspaces")
    .dropColumn("open_to_all")
    .dropColumn("settings")
    .dropColumn("created_by")
    .dropColumn("deleted_at")
    .execute();
}
