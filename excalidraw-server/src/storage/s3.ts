import { AwsClient } from "aws4fetch";

import type { S3Config } from "../config.js";
import type { BlobStore, StoredBlob } from "./index.js";

const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

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

  async put(
    key: string,
    data: Buffer,
    meta: { contentType: string | null; createdBy: string | null },
  ): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": meta.contentType || "application/octet-stream",
    };
    if (meta.createdBy) {
      headers["x-amz-meta-created-by"] = meta.createdBy;
    }
    const response = await this.client.fetch(this.objectUrl(key), {
      method: "PUT",
      headers,
      body: new Uint8Array(data),
    });
    if (!response.ok) {
      throw new Error(`S3 PUT ${key} failed with status ${response.status}`);
    }
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
      // copy into a plain Uint8Array: valid fetch body for every typing
      body: new Uint8Array(data),
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

  async deletePrefix(prefix: string): Promise<number> {
    const fullPrefix = this.s3.prefix ? `${this.s3.prefix}/${prefix}` : prefix;
    let deleted = 0;
    let token: string | null = null;
    do {
      const params = new URLSearchParams({
        "list-type": "2",
        prefix: fullPrefix,
      });
      if (token) {
        params.set("continuation-token", token);
      }
      const response = await this.client.fetch(`${this.bucketUrl()}?${params}`);
      if (!response.ok) {
        throw new Error(
          `S3 LIST ${prefix} failed with status ${response.status}`,
        );
      }
      const xml = await response.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) =>
        decodeXml(match[1]),
      );
      for (const key of keys) {
        const encoded = key.split("/").map(encodeURIComponent).join("/");
        const removed = await this.client.fetch(
          `${this.bucketUrl()}/${encoded}`,
          {
            method: "DELETE",
          },
        );
        if (!removed.ok && removed.status !== 404) {
          throw new Error(
            `S3 DELETE ${key} failed with status ${removed.status}`,
          );
        }
        deleted++;
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(
            /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
              xml,
            )?.[1] || "",
          ) || null
        : null;
    } while (token);
    return deleted;
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
