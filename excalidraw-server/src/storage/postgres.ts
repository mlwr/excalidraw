import { sql } from "kysely";

import type { Database } from "../db/schema.js";
import type { BlobStore, StoredBlob } from "./index.js";
import type { Kysely } from "kysely";

/**
 * Default driver: files live in PostgreSQL. One dependency less to operate,
 * and database backups include the images.
 */
export class PostgresBlobStore implements BlobStore {
  constructor(private readonly db: Kysely<Database>) {}

  async putIfAbsent(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<boolean> {
    const result = await this.db
      .insertInto("blobs")
      .values({
        key,
        data,
        size: data.byteLength,
        content_type: meta.contentType,
        created_by: meta.createdBy,
      })
      .onConflict((oc) => oc.column("key").doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async put(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<void> {
    await this.db
      .insertInto("blobs")
      .values({
        key,
        data,
        size: data.byteLength,
        content_type: meta.contentType,
        created_by: meta.createdBy,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          data,
          size: data.byteLength,
          content_type: meta.contentType,
          created_at: sql`now()`,
        }),
      )
      .execute();
  }

  async get(key: string): Promise<StoredBlob | null> {
    const row = await this.db
      .selectFrom("blobs")
      .select(["data", "content_type"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? { data: row.data, contentType: row.content_type } : null;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const result = await this.db
      .deleteFrom("blobs")
      .where("key", "like", pattern)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async check(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }
}
