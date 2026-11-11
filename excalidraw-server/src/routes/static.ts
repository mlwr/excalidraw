import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";

import type { Config } from "../config.js";
import type { FastifyInstance, FastifyReply } from "fastify";

const NO_CACHE_FILES = new Set([
  "index.html",
  "sw.js",
  "service-worker.js",
  "registerSW.js",
  "manifest.webmanifest",
  "version.json",
]);

/** sha256 source hashes of the inline <script> blocks of index.html */
const inlineScriptHashes = (html: string): string[] => {
  const hashes: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const attributes = match[1] || "";
    if (/\ssrc\s*=/i.test(attributes)) {
      continue;
    }
    const digest = createHash("sha256")
      .update(match[2], "utf8")
      .digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
};

export const buildContentSecurityPolicy = (
  config: Config,
  scriptHashes: string[],
): string => {
  const issuerOrigin = config.oidc.issuerUrl.origin;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // wasm: font subsetting on export (harfbuzz / woff2)
    "script-src": ["'self'", "'wasm-unsafe-eval'", ...scriptHashes],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "data:", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "frame-src": ["'self'", ...config.cspFrameSrc],
    "frame-ancestors": ["'self'", ...config.cspFrameAncestors],
    "form-action": ["'self'", issuerOrigin],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
};

/**
 * Serves the built app (single image deployments). Without STATIC_DIR the
 * server is API-only and the app is served by another web server.
 */
export const registerStatic = async (app: FastifyInstance, config: Config) => {
  if (!config.staticDir) {
    return;
  }
  const root = path.resolve(config.staticDir);
  const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
  const csp = buildContentSecurityPolicy(config, inlineScriptHashes(indexHtml));

  const securityHeaders: Record<string, string> = {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (!config.cspFrameAncestors.length) {
    securityHeaders["x-frame-options"] = "SAMEORIGIN";
  }
  if (config.publicUrl.protocol === "https:") {
    securityHeaders["strict-transport-security"] = "max-age=31536000";
  }

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    index: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      for (const [name, value] of Object.entries(securityHeaders)) {
        res.header(name, value);
      }
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      if (NO_CACHE_FILES.has(relative) || relative.startsWith("workbox-")) {
        res.header("cache-control", "no-cache");
      } else if (relative.startsWith("assets/")) {
        // content-hashed file names
        res.header("cache-control", "public, max-age=31536000, immutable");
      } else {
        res.header("cache-control", "public, max-age=86400");
      }
    },
  });

  const sendIndexHtml = (reply: FastifyReply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.header(name, value);
    }
    return reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(indexHtml);
  };

  app.get("/", (_request, reply) => sendIndexHtml(reply));

  // single page app: unknown non-API GET routes get index.html
  app.setNotFoundHandler((request, reply) => {
    const isApi =
      request.url.startsWith("/api/") || request.url.startsWith("/socket.io/");
    if (request.method !== "GET" || isApi) {
      return reply
        .code(404)
        .header("cache-control", "no-store")
        .send({ error: "not_found", message: "not_found" });
    }
    return sendIndexHtml(reply);
  });
};
