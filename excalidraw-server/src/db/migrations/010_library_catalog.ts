import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 6 (L3): the company's own library catalog, instead of
// libraries.excalidraw.com. Items and previews are encrypted like scenes.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("library_catalog")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("size", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("key_sealed", "bytea", (col) => col.notNull())
    .addColumn("content", "bytea", (col) => col.notNull())
    .addColumn("preview", "bytea")
    .addColumn("downloads", "integer", (col) => col.notNull().defaultTo(0))
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
  await db.schema
    .createIndex("library_catalog_updated_idx")
    .on("library_catalog")
    .column("updated_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("library_catalog").execute();
}
