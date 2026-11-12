import { sql } from "kysely";

import type { Kysely } from "kysely";

// Phase 6 (E3): the company's own fonts, uploaded by the app admins. Ids
// start at 1001 and are never given out twice: text in a removed font
// keeps its id and falls back to another font.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table company_fonts (
      id integer generated always as identity (start with 1001) primary key,
      family text not null,
      file bytea not null,
      size integer not null,
      metrics jsonb not null,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index company_fonts_family_idx
    on company_fonts (lower(family)) where deleted_at is null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("company_fonts").execute();
}
