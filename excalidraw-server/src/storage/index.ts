import { PostgresBlobStore } from "./postgres.js";
import { S3BlobStore } from "./s3.js";

import type { Config } from "../config.js";
import type { Database } from "../db/schema.js";
import type { Kysely } from "kysely";

export interface StoredBlob {
  data: Buffer;
  contentType: string | null;
}

/**
 * Storage for binary files (images). Keys look like
 * `files/rooms/<roomId>/<fileId>`. Objects are write-once: file ids are
 * content hashes, so an existing object is never replaced.
 */
export interface BlobStore {
  /** returns false if the key already existed (nothing was written) */
  putIfAbsent(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<boolean>;
  /** write or replace (derived data such as thumbnails) */
  put(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  /** delete every object whose key starts with prefix (purging scenes) */
  deletePrefix(prefix: string): Promise<number>;
  /** cheap reachability check for readiness probes */
  check(): Promise<void>;
}

export const createBlobStore = (
  config: Config,
  db: Kysely<Database>,
): BlobStore => {
  if (config.storage.driver === "s3" && config.storage.s3) {
    return new S3BlobStore(config.storage.s3);
  }
  return new PostgresBlobStore(db);
};
