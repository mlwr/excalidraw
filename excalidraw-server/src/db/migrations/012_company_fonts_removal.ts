import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 6 review: a removed company font is deleted, file and uploader
// included (as the data protection notes say); ids still never come back.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`delete from company_fonts where deleted_at is not null`.execute(db);
  await sql`drop index company_fonts_family_idx`.execute(db);
  await sql`alter table company_fonts drop column deleted_at`.execute(db);
  await sql`
    create unique index company_fonts_family_idx
    on company_fonts (lower(family))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table company_fonts add column deleted_at timestamptz`.execute(
    db,
  );
  await sql`drop index company_fonts_family_idx`.execute(db);
  await sql`
    create unique index company_fonts_family_idx
    on company_fonts (lower(family)) where deleted_at is null
  `.execute(db);
}
