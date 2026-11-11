import { AwsClient } from "aws4fetch";

import type { S3Config } from "../config.js";
import type { BlobStore, StoredBlob } from "./index.js";

/**
 * Optional driver for any S3-compatible object storage (Ceph RGW, MinIO,
 * NetApp StorageGRID, ...). Uses plain signed HTTP requests, no AWS SDK.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: AwsClient;

  constructor(private readonly s3: S3Config) {
    this.client = new AwsClient({
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      region: s3.region,
      service: "s3",
    });
  }

  private objectUrl(key: string): string {
    const fullKey = this.s3.prefix ? `${this.s3.prefix}/${key}` : key;
    const encodedKey = fullKey.split("/").map(encodeURIComponent).join("/");
    if (this.s3.forcePathStyle) {
      return `${this.s3.endpoint}/${this.s3.bucket}/${encodedKey}`;
    }
    const endpoint = new URL(this.s3.endpoint);
    return `${endpoint.protocol}//${this.s3.bucket}.${endpoint.host}/${encodedKey}`;
  }

  private bucketUrl(): string {
    if (this.s3.forcePathStyle) {
      return `${this.s3.endpoint}/${this.s3.bucket}`;
    }
    const endpoint = new URL(this.s3.endpoint);
    return `${endpoint.protocol}//${this.s3.bucket}.${endpoint.host}`;
  }

  async putIfAbsent(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<boolean> {
    const head = await this.client.fetch(this.objectUrl(key), {
      method: "HEAD",
    });
    if (head.ok) {
      return false;
    }
    if (head.status !== 404) {
      throw new Error(`S3 HEAD ${key} failed with status ${head.status}`);
    }
    const headers: Record<string, string> = {
      "content-type": meta.contentType || "application/octet-stream",
    };
    if (meta.createdBy) {
      headers["x-amz-meta-created-by"] = meta.createdBy;
    }
    const response = await this.client.fetch(this.objectUrl(key), {
      method: "PUT",
      headers,
      body: data,
    });
    if (!response.ok) {
      throw new Error(`S3 PUT ${key} failed with status ${response.status}`);
    }
    return true;
  }

  async get(key: string): Promise<StoredBlob | null> {
    const response = await this.client.fetch(this.objectUrl(key));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`S3 GET ${key} failed with status ${response.status}`);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type"),
    };
  }

  async check(): Promise<void> {
    const response = await this.client.fetch(this.bucketUrl(), {
      method: "HEAD",
    });
    if (!response.ok) {
      throw new Error(`S3 bucket check failed with status ${response.status}`);
    }
  }
}
