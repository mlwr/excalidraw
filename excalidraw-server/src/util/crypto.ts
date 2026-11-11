import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** URL-safe random token with `bytes` bytes of entropy */
export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString("base64url");

/** hex sha256, used to store lookup keys for secrets instead of the secrets */
export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Accept only same-origin relative paths as post-login targets so the login
 * endpoint cannot be abused as an open redirect.
 */
export const sanitizeReturnTo = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (/[\\\r\n\t]/.test(value) || value.includes("#")) {
    return "/";
  }
  return value;
};

// -----------------------------------------------------------------------------
// encryption at rest
// -----------------------------------------------------------------------------

const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const aesGcmEncrypt = (
  algorithm: "aes-128-gcm" | "aes-256-gcm",
  key: Buffer,
  plaintext: Buffer,
): Buffer => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([SEAL_VERSION]),
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]);
};

const aesGcmDecrypt = (
  algorithm: "aes-128-gcm" | "aes-256-gcm",
  key: Buffer,
  sealed: Buffer,
): Buffer => {
  if (sealed[0] !== SEAL_VERSION || sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error("unknown encryption format");
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(1 + IV_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

/**
 * Per-scene key in the format the browser uses for live sessions (128-bit
 * AES-GCM key as base64url, see `generateEncryptionKey` in the editor).
 */
export const generateSceneKey = (): string =>
  randomBytes(16).toString("base64url");

/** encrypt a scene key with the server's master key (envelope encryption) */
export const sealSceneKey = (masterKey: Buffer, sceneKey: string): Buffer =>
  aesGcmEncrypt("aes-256-gcm", masterKey, Buffer.from(sceneKey, "utf8"));

export const openSceneKey = (masterKey: Buffer, sealed: Buffer): string =>
  aesGcmDecrypt("aes-256-gcm", masterKey, sealed).toString("utf8");

/** server-side encryption of derived data (thumbnails) with the scene key */
export const encryptWithSceneKey = (sceneKey: string, data: Buffer): Buffer =>
  aesGcmEncrypt("aes-128-gcm", Buffer.from(sceneKey, "base64url"), data);

export const decryptWithSceneKey = (sceneKey: string, sealed: Buffer): Buffer =>
  aesGcmDecrypt("aes-128-gcm", Buffer.from(sceneKey, "base64url"), sealed);
