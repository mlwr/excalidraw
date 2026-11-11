/**
 * Scene content in the formats the browser writes, so the server can read
 * and change scenes for the REST API and the MCP server:
 *
 * - elements: JSON, AES-128-GCM with the scene key (WebCrypto layout: the
 *   12-byte IV separate, the tag appended to the ciphertext)
 * - image files: the editor's container (`compressData` in
 *   packages/excalidraw/data/encode.ts): length-prefixed chunks, deflated,
 *   encrypted the same way
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import type { SceneElement } from "../../vendor/elements.mjs";

const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyBytes = (key: string) => Buffer.from(key, "base64url");

export const encryptForBrowser = (key: string, plaintext: Buffer) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-128-gcm", keyBytes(key), iv);
  const data = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv, data };
};

export const decryptFromBrowser = (key: string, iv: Buffer, data: Buffer) => {
  if (data.length < TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const decipher = createDecipheriv("aes-128-gcm", keyBytes(key), iv);
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - TAG_BYTES)),
    decipher.final(),
  ]);
};

/** like the editor's getSceneVersion: changes whenever any element changes */
export const sceneVersionOf = (elements: readonly SceneElement[]) =>
  Math.min(
    Number.MAX_SAFE_INTEGER,
    elements.reduce(
      (sum, element) =>
        sum + Math.max(0, Math.trunc(Number(element.version) || 0)),
      0,
    ),
  );

export const decryptElements = (
  key: string,
  iv: Buffer,
  ciphertext: Buffer,
): SceneElement[] => {
  const elements = JSON.parse(
    decryptFromBrowser(key, iv, ciphertext).toString("utf8"),
  );
  if (!Array.isArray(elements)) {
    throw new Error("scene content is not an element list");
  }
  return elements;
};

export const encryptElements = (
  key: string,
  elements: readonly SceneElement[],
) => encryptForBrowser(key, Buffer.from(JSON.stringify(elements), "utf8"));

// --- image files ------------------------------------------------------------

const CONCAT_VERSION = 1;

const concatBuffers = (...buffers: Buffer[]) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(CONCAT_VERSION);
  const parts: Buffer[] = [head];
  for (const buffer of buffers) {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(buffer.length);
    parts.push(size, buffer);
  }
  return Buffer.concat(parts);
};

const splitBuffers = (buffer: Buffer) => {
  if (buffer.length < 4 || buffer.readUInt32BE(0) > CONCAT_VERSION) {
    throw new Error("not an encoded file");
  }
  const chunks: Buffer[] = [];
  let cursor = 4;
  while (cursor < buffer.length) {
    if (cursor + 4 > buffer.length) {
      throw new Error("truncated file");
    }
    const size = buffer.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + size > buffer.length) {
      throw new Error("truncated file");
    }
    chunks.push(buffer.subarray(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
};

export interface FileMetadata {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved?: number;
}

/** an image file as the editor stores it: metadata and data URL */
export const decodeFile = (key: string, stored: Buffer, maxBytes: number) => {
  const [encoding, iv, encrypted] = splitBuffers(stored);
  const info = JSON.parse(encoding.toString("utf8")) as {
    compression?: string | null;
  };
  const decrypted = decryptFromBrowser(key, iv, encrypted);
  // never inflate beyond what an image may be (no decompression bombs)
  const contents: Buffer = info.compression
    ? inflateSync(decrypted, { maxOutputLength: maxBytes })
    : decrypted;
  const [metadata, data] = splitBuffers(contents);
  return {
    metadata: JSON.parse(metadata.toString("utf8")) as FileMetadata,
    dataURL: data.toString("utf8"),
  };
};

export const encodeFile = (
  key: string,
  metadata: FileMetadata,
  dataURL: string,
) => {
  const encoding = Buffer.from(
    JSON.stringify({
      version: 2,
      compression: "pako@1",
      encryption: "AES-GCM",
    }),
  );
  const contents = deflateSync(
    concatBuffers(
      Buffer.from(JSON.stringify(metadata)),
      Buffer.from(dataURL, "utf8"),
    ),
  );
  const { iv, data } = encryptForBrowser(key, contents);
  return concatBuffers(encoding, iv, data);
};
