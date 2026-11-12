import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 6 (W4): team collections inside team collections, e.g.
// Abteilung › Projekt › Thema. Access is inherited downwards.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("collections")
    .addColumn("parent_id", "uuid", (col) => col.references("collections.id"))
    .execute();
  await db.schema
    .createIndex("collections_parent_idx")
    .on("collections")
    .column("parent_id")
    .where(sql.ref("parent_id"), "is not", null)
    .execute();
  // only team collections nest, never into themselves
  await sql`
    alter table collections add constraint collections_parent_check
    check (parent_id is null or (kind = 'team' and parent_id <> id))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table collections drop constraint collections_parent_check`.execute(
    db,
  );
  await db.schema.alterTable("collections").dropColumn("parent_id").execute();
}
