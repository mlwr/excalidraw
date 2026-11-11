import type { OidcConfig } from "../config.js";

export type Claims = Record<string, unknown>;

export interface MappedIdentity {
  subject: string;
  name: string;
  email: string | null;
  username: string | null;
  roles: string[];
  groups: string[];
  isAdmin: boolean;
  /** Keycloak session id, used to match back-channel logout tokens */
  sid: string | null;
}

const getPath = (claims: Claims, path: string[]): unknown => {
  let current: unknown = claims;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value) {
    return [value];
  }
  return [];
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Keycloak lists only direct memberships ("/IT/Architektur"). Members of a
 * subgroup also belong to its parents (Keycloak inherits role mappings the
 * same way), so a grant to "/IT" covers "/IT/Architektur" too. Names without
 * a leading slash ("Full group path" off) have no hierarchy and stay as-is.
 */
export const withParentGroups = (groups: Iterable<string>): string[] => {
  const result = new Set<string>();
  for (const group of groups) {
    if (!group.startsWith("/")) {
      result.add(group);
      continue;
    }
    const segments = group.split("/").slice(1);
    for (let depth = 1; depth <= segments.length; depth++) {
      result.add(`/${segments.slice(0, depth).join("/")}`);
    }
  }
  return [...result].sort();
};

/**
 * Decode the payload of a JWT without verifying it. Only used for the access
 * token we just received directly from the token endpoint (authenticated
 * TLS channel), because Keycloak puts roles there and not into the ID token.
 */
export const decodeJwtPayload = (token: string | undefined): Claims => {
  if (!token) {
    return {};
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {};
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
};

/**
 * Map Keycloak claims to the app's identity. Roles and groups are read from
 * every source (ID token, access token, userinfo), because which token carries
 * them depends on the mapper settings of the Keycloak client.
 */
export const mapIdentity = (
  oidc: OidcConfig,
  sources: Claims[],
): MappedIdentity => {
  const merged: Claims = Object.assign({}, ...[...sources].reverse());

  const roles = new Set<string>();
  const groups = new Set<string>();
  for (const source of sources) {
    for (const path of oidc.rolesClaims) {
      toStringList(getPath(source, path)).forEach((role) => roles.add(role));
    }
    toStringList(getPath(source, oidc.groupsClaim)).forEach((group) =>
      groups.add(group),
    );
  }

  const subject = str(merged.sub);
  if (!subject) {
    throw new Error("ID token has no subject");
  }

  const username = str(merged.preferred_username);
  const email = str(merged.email);
  const fullName =
    str(merged.name) ||
    [str(merged.given_name), str(merged.family_name)]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    null;

  return {
    subject,
    name: fullName || username || email || subject,
    email,
    username,
    roles: [...roles].sort(),
    groups: withParentGroups(groups),
    isAdmin: roles.has(oidc.adminRole),
    sid: str(merged.sid),
  };
};

/** whether the identity may use the app at all */
export const hasAccess = (oidc: OidcConfig, identity: MappedIdentity) =>
  !oidc.requiredRole ||
  identity.roles.includes(oidc.requiredRole) ||
  identity.isAdmin;
