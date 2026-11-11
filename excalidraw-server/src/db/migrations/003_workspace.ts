import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 2: workspace with collections and server-side scenes.
//
// Scene content is AES-GCM encrypted with a per-scene key (the browser
// encrypts, like in live sessions); the scene keys themselves are encrypted
// with the server's DATA_ENCRYPTION_KEY (envelope encryption).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("collections")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("workspace_id", "uuid", (col) =>
      col.notNull().references("workspaces.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    // personal: "Meine Szenen" of one user; team: shared via grants
    .addColumn("kind", "text", (col) =>
      col.notNull().check(sql`kind in ('personal', 'team')`),
    )
    .addColumn("owner_id", "uuid", (col) =>
      col.references("users.id").onDelete("cascade"),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .execute();
  await sql`create unique index collections_personal_owner_idx on collections (owner_id) where kind = 'personal'`.execute(
    db,
  );

  await db.schema
    .createTable("collection_grants")
    .addColumn("collection_id", "uuid", (col) =>
      col.notNull().references("collections.id").onDelete("cascade"),
    )
    .addColumn("principal_type", "text", (col) =>
      col.notNull().check(sql`principal_type in ('user', 'group')`),
    )
    .addColumn("principal", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) =>
      col.notNull().check(sql`role in ('viewer', 'editor', 'manager')`),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("collection_grants_pk", [
      "collection_id",
      "principal_type",
      "principal",
    ])
    .execute();

  await db.schema
    .createTable("scenes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workspace_id", "uuid", (col) =>
      col.notNull().references("workspaces.id").onDelete("cascade"),
    )
    .addColumn("collection_id", "uuid", (col) =>
      col.notNull().references("collections.id").onDelete("restrict"),
    )
    .addColumn("name", "text", (col) => col.notNull())
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
    .addColumn("deleted_at", "timestamptz")
    // content: 0 = no content saved yet
    .addColumn("revision", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("scene_version", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("iv", "bytea")
    .addColumn("ciphertext", "bytea")
    .addColumn("key_sealed", "bytea", (col) => col.notNull())
    .addColumn("thumbnail_updated_at", "timestamptz")
    .addColumn("read_link_token", "text", (col) => col.unique())
    .execute();
  await db.schema
    .createIndex("scenes_collection_updated_idx")
    .on("scenes")
    .columns(["collection_id", "updated_at"])
    .execute();

  await db.schema
    .createTable("scene_grants")
    .addColumn("scene_id", "text", (col) =>
      col.notNull().references("scenes.id").onDelete("cascade"),
    )
    .addColumn("principal_type", "text", (col) =>
      col.notNull().check(sql`principal_type in ('user', 'group')`),
    )
    .addColumn("principal", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) =>
      col.notNull().check(sql`role in ('viewer', 'editor')`),
    )
    .addColumn("created_by", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("scene_grants_pk", [
      "scene_id",
      "principal_type",
      "principal",
    ])
    .execute();

  await db.schema
    .createTable("scene_visits")
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("scene_id", "text", (col) =>
      col.notNull().references("scenes.id").onDelete("cascade"),
    )
    .addColumn("visited_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("scene_visits_pk", ["user_id", "scene_id"])
    .execute();

  // who opened a scene through its read-only link (valid while the token is)
  await db.schema
    .createTable("scene_link_viewers")
    .addColumn("scene_id", "text", (col) =>
      col.notNull().references("scenes.id").onDelete("cascade"),
    )
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("token", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("scene_link_viewers_pk", ["scene_id", "user_id"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    "scene_link_viewers",
    "scene_visits",
    "scene_grants",
    "scenes",
    "collection_grants",
    "collections",
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
