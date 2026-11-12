import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 4, after review: one version per scene revision, a "comments
// changed" mark for the search index that indexing cannot overwrite, and a
// grace period for scenes deleted before there was a trash.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    delete from scene_versions a
    using scene_versions b
    where a.scene_id = b.scene_id and a.revision = b.revision and a.id > b.id
  `.execute(db);
  await db.schema
    .createIndex("scene_versions_revision_idx")
    .on("scene_versions")
    .columns(["scene_id", "revision"])
    .unique()
    .execute();

  await db.schema
    .alterTable("scene_search")
    .addColumn("dirty_at", "timestamptz")
    .execute();

  // Until phase 4 deleted scenes were only hidden. Their trash period
  // starts with the update instead of being over already.
  await sql`
    update scenes set deleted_at = now()
    where deleted_at is not null and deleted_at < now()
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("scene_search").dropColumn("dirty_at").execute();
  await db.schema.dropIndex("scene_versions_revision_idx").execute();
}
