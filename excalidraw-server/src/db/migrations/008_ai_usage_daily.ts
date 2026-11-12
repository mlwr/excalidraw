import type { Kysely } from "kysely";

// Phase 5 review: AI usage per person is needed only for today's limit.
// Older days are kept as sums per day, without any person in them.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ai_usage_daily")
    .addColumn("day", "date", (col) => col.primaryKey())
    .addColumn("requests", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("people", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("prompt_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("completion_tokens", "bigint", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ai_usage_daily").execute();
}
