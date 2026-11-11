/**
 * Server configuration, read once from environment variables.
 *
 * Every variable is documented in docs/intranet/configuration.md. Required
 * variables without a value make the server refuse to start with a message
 * that names all of them at once.
 */

export type StorageDriver = "postgres" | "s3";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** path-style URLs (http://host/bucket/key), needed for MinIO, Ceph etc. */
  forcePathStyle: boolean;
  /** optional key prefix inside the bucket */
  prefix: string;
}

export interface OidcConfig {
  issuerUrl: URL;
  clientId: string;
  clientSecret: string | null;
  scopes: string;
  /** claim paths (split at dots) that contain role lists */
  rolesClaims: string[][];
  /** claim path (split at dots) that contains the group list */
  groupsClaim: string[];
  /** role that grants admin rights in the app */
  adminRole: string;
  /** role a user needs to use the app at all; null = every authenticated user */
  requiredRole: string | null;
  /** allow plain http to the identity provider (local development only) */
  allowInsecureHttp: boolean;
  /** where Keycloak sends the browser after logout */
  postLogoutRedirectUrl: string;
}

export interface Config {
  host: string;
  port: number;
  /** externally visible base URL, e.g. https://excalidraw.intranet.example */
  publicUrl: URL;
  /** value for Fastify's trustProxy option */
  trustProxy: boolean | string | ((address: string, hop: number) => boolean);
  databaseUrl: string;
  databasePoolSize: number;
  autoMigrate: boolean;
  oidc: OidcConfig;
  session: {
    cookieName: string;
    ttlSeconds: number;
    secureCookie: boolean;
  };
  storage: {
    driver: StorageDriver;
    s3: S3Config | null;
  };
  limits: {
    maxFileBytes: number;
    maxSceneBytes: number;
    maxShareLinkBytes: number;
    maxImageDimension: number;
  };
  realtime: {
    /** use the PostgreSQL adapter so that several server pods share rooms */
    cluster: boolean;
    maxPayloadBytes: number;
  };
  /** directory with the built app (excalidraw-app/build); null = API only */
  staticDir: string | null;
  /** extra origins allowed as iframe sources (embeddables), space separated */
  cspFrameSrc: string[];
  /** origins allowed to embed the app in an iframe, space separated */
  cspFrameAncestors: string[];
  /** URL of an internal library catalog; null hides "browse libraries" */
  libraryBrowseUrl: string | null;
  /** 32-byte master key that encrypts the per-scene keys */
  dataEncryptionKey: Buffer;
  api: {
    /** REST API under /api/v1 and personal API tokens */
    enabled: boolean;
    /** MCP server under /mcp (needs the API) */
    mcpEnabled: boolean;
    /** longest lifetime of a token */
    tokenMaxDays: number;
    /**
     * tokens work only while their person signed in to the app within this
     * many days (roles and groups are as of that login); 0 = no limit
     */
    loginMaxAgeDays: number;
    /** role needed to create and use tokens; null = everyone */
    requiredRole: string | null;
    /** requests per token and minute */
    rateLimitPerMinute: number;
  };
  logLevel: string;
}

type Env = Record<string, string | undefined>;

const MB = 1024 * 1024;

class ConfigError extends Error {}

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const parseNumber = (
  name: string,
  value: string | undefined,
  fallback: number,
  errors: string[],
): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive number (got "${value}")`);
    return fallback;
  }
  return parsed;
};

const parseUrl = (
  name: string,
  value: string | undefined,
  errors: string[],
): URL | null => {
  if (!value) {
    errors.push(`${name} is required`);
    return null;
  }
  try {
    return new URL(value);
  } catch {
    errors.push(`${name} must be an absolute URL (got "${value}")`);
    return null;
  }
};

const splitList = (value: string | undefined): string[] =>
  (value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const trustHops = (hops: number) => (_address: string, hop: number) =>
  hop < hops;

const parseEncryptionKey = (
  value: string | undefined,
  errors: string[],
): Buffer => {
  const key = Buffer.from((value || "").trim(), "base64");
  if (key.length !== 32) {
    errors.push(
      "DATA_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (e.g. `openssl rand -base64 32`)",
    );
    return Buffer.alloc(32);
  }
  return key;
};

const parseTrustProxy = (
  value: string | undefined,
): boolean | string | ((address: string, hop: number) => boolean) => {
  if (value === undefined || value.trim() === "") {
    // behind an ingress controller by default: trust the first hop
    return trustHops(1);
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  if (/^\d+$/.test(lowered)) {
    return trustHops(Number(lowered));
  }
  return value.trim();
};

export const loadConfig = (env: Env = process.env): Config => {
  const errors: string[] = [];

  const publicUrl = parseUrl("PUBLIC_URL", env.PUBLIC_URL, errors);
  const issuerUrl = parseUrl("OIDC_ISSUER_URL", env.OIDC_ISSUER_URL, errors);

  if (!env.DATABASE_URL) {
    errors.push("DATABASE_URL is required");
  }
  if (!env.OIDC_CLIENT_ID) {
    errors.push("OIDC_CLIENT_ID is required");
  }

  const driver = (env.STORAGE_DRIVER || "postgres").trim() as StorageDriver;
  if (driver !== "postgres" && driver !== "s3") {
    errors.push(`STORAGE_DRIVER must be "postgres" or "s3" (got "${driver}")`);
  }

  let s3: S3Config | null = null;
  if (driver === "s3") {
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      if (!env[name]) {
        errors.push(`${name} is required when STORAGE_DRIVER=s3`);
      }
    }
    s3 = {
      endpoint: (env.S3_ENDPOINT || "").replace(/\/+$/, ""),
      region: env.S3_REGION || "us-east-1",
      bucket: env.S3_BUCKET || "",
      accessKeyId: env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || "",
      forcePathStyle: parseBool(env.S3_FORCE_PATH_STYLE, true),
      prefix: (env.S3_PREFIX || "").replace(/^\/+|\/+$/g, ""),
    };
  }

  const clientId = env.OIDC_CLIENT_ID || "";
  // the client id may contain dots, so default paths are built as arrays
  const rolesClaims = env.OIDC_ROLES_CLAIMS
    ? splitList(env.OIDC_ROLES_CLAIMS).map((path) => path.split("."))
    : [
        ["realm_access", "roles"],
        ["resource_access", clientId, "roles"],
      ];

  const ttlHours = parseNumber(
    "SESSION_TTL_HOURS",
    env.SESSION_TTL_HOURS,
    10,
    errors,
  );

  const config: Config = {
    host: env.HOST || "0.0.0.0",
    port: parseNumber("PORT", env.PORT, 8080, errors),
    publicUrl: publicUrl || new URL("http://localhost:8080"),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    databaseUrl: env.DATABASE_URL || "",
    databasePoolSize: parseNumber(
      "DATABASE_POOL_SIZE",
      env.DATABASE_POOL_SIZE,
      10,
      errors,
    ),
    autoMigrate: parseBool(env.AUTO_MIGRATE, true),
    oidc: {
      issuerUrl: issuerUrl || new URL("http://localhost"),
      clientId,
      clientSecret: env.OIDC_CLIENT_SECRET || null,
      scopes: env.OIDC_SCOPES || "openid profile email",
      rolesClaims,
      groupsClaim: (env.OIDC_GROUPS_CLAIM || "groups").split("."),
      adminRole: env.OIDC_ADMIN_ROLE || "excalidraw-admin",
      requiredRole: env.OIDC_REQUIRED_ROLE?.trim() || null,
      allowInsecureHttp: parseBool(env.OIDC_ALLOW_INSECURE_HTTP, false),
      postLogoutRedirectUrl:
        env.OIDC_POST_LOGOUT_REDIRECT_URL ||
        (publicUrl ? publicUrl.toString() : "/"),
    },
    session: {
      cookieName: env.SESSION_COOKIE_NAME || "excalidraw_session",
      ttlSeconds: Math.round(ttlHours * 3600),
      secureCookie: parseBool(
        env.SESSION_COOKIE_SECURE,
        publicUrl ? publicUrl.protocol === "https:" : true,
      ),
    },
    storage: { driver, s3 },
    limits: {
      maxFileBytes: Math.round(
        parseNumber("MAX_FILE_SIZE_MB", env.MAX_FILE_SIZE_MB, 25, errors) * MB,
      ),
      maxSceneBytes: Math.round(
        parseNumber("MAX_SCENE_SIZE_MB", env.MAX_SCENE_SIZE_MB, 50, errors) *
          MB,
      ),
      maxShareLinkBytes: Math.round(
        parseNumber(
          "MAX_SHARE_LINK_SIZE_MB",
          env.MAX_SHARE_LINK_SIZE_MB,
          50,
          errors,
        ) * MB,
      ),
      maxImageDimension: Math.round(
        parseNumber(
          "MAX_IMAGE_DIMENSION",
          env.MAX_IMAGE_DIMENSION,
          3840,
          errors,
        ),
      ),
    },
    realtime: {
      cluster: parseBool(env.REALTIME_CLUSTER, false),
      maxPayloadBytes: Math.round(
        parseNumber(
          "REALTIME_MAX_PAYLOAD_MB",
          env.REALTIME_MAX_PAYLOAD_MB,
          50,
          errors,
        ) * MB,
      ),
    },
    staticDir: env.STATIC_DIR?.trim() || null,
    cspFrameSrc: splitList(env.CSP_FRAME_SRC),
    cspFrameAncestors: splitList(env.CSP_FRAME_ANCESTORS),
    libraryBrowseUrl: env.LIBRARY_BROWSE_URL?.trim() || null,
    dataEncryptionKey: parseEncryptionKey(env.DATA_ENCRYPTION_KEY, errors),
    api: {
      enabled: parseBool(env.API_ENABLED, true),
      mcpEnabled:
        parseBool(env.API_ENABLED, true) && parseBool(env.MCP_ENABLED, true),
      tokenMaxDays: Math.round(
        parseNumber("API_TOKEN_MAX_DAYS", env.API_TOKEN_MAX_DAYS, 365, errors),
      ),
      loginMaxAgeDays: (() => {
        const value = env.API_TOKEN_LOGIN_MAX_AGE_DAYS;
        if (value !== undefined && value.trim() === "0") {
          return 0;
        }
        return Math.round(
          parseNumber("API_TOKEN_LOGIN_MAX_AGE_DAYS", value, 30, errors),
        );
      })(),
      requiredRole: env.API_REQUIRED_ROLE?.trim() || null,
      rateLimitPerMinute: Math.round(
        parseNumber(
          "API_RATE_LIMIT_PER_MINUTE",
          env.API_RATE_LIMIT_PER_MINUTE,
          300,
          errors,
        ),
      ),
    },
    logLevel: env.LOG_LEVEL || "info",
  };

  if (
    publicUrl &&
    publicUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(publicUrl.hostname) &&
    !parseBool(env.ALLOW_INSECURE_PUBLIC_URL, false)
  ) {
    errors.push(
      "PUBLIC_URL must use https (set ALLOW_INSECURE_PUBLIC_URL=true to override for tests)",
    );
  }

  if (publicUrl && (publicUrl.pathname !== "/" || publicUrl.search)) {
    errors.push(
      "PUBLIC_URL must be an origin without path, e.g. https://excalidraw.intranet.example",
    );
  }

  if (
    issuerUrl &&
    issuerUrl.protocol !== "https:" &&
    !config.oidc.allowInsecureHttp
  ) {
    errors.push(
      "OIDC_ISSUER_URL must use https (set OIDC_ALLOW_INSECURE_HTTP=true for local development)",
    );
  }

  if (errors.length) {
    throw new ConfigError(
      `Invalid configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return config;
};
