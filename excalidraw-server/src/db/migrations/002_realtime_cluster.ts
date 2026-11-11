import { sql } from "kysely";

import type { Kysely } from "kysely";

// table used by @socket.io/postgres-adapter for payloads larger than the
// NOTIFY limit when several server pods share realtime rooms
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table if not exists socket_io_attachments (
      id bigserial unique,
      created_at timestamptz default now(),
      payload bytea
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("socket_io_attachments").ifExists().execute();
}
