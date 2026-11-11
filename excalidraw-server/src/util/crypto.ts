import { createHash, randomBytes } from "node:crypto";

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
