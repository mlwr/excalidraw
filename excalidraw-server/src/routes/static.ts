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

/** an embedding link (T3): the only page of the app intranet pages may frame */
export const EMBED_PATH_RE = /^\/embed\/[A-Za-z0-9_-]{16,64}\/?$/;

export const buildContentSecurityPolicy = (
  config: Config,
  scriptHashes: string[],
  /** /embed pages: the intranet pages that may show them (T3) */
  frameAncestors: string[] = config.cspFrameAncestors,
  /** pages the editor may embed (E2) */
  frameSources: string[] = config.cspFrameSrc,
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
    "frame-src": ["'self'", ...frameSources],
    "frame-ancestors": ["'self'", ...frameAncestors],
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
export const registerStatic = async (
  app: FastifyInstance,
  config: Config,
  /** frame sources the admins allow; they change at runtime (E2) */
  frameSources: () => Promise<string[]> = async () => config.cspFrameSrc,
) => {
  if (!config.staticDir) {
    return;
  }
  const root = path.resolve(config.staticDir);
  const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
  const scriptHashes = inlineScriptHashes(indexHtml);
  const csp = buildContentSecurityPolicy(config, scriptHashes);

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

  const sendIndexHtml = async (reply: FastifyReply, embed = false) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.header(name, value);
    }
    const sources = await frameSources().catch(() => config.cspFrameSrc);
    reply.header(
      "content-security-policy",
      buildContentSecurityPolicy(
        config,
        scriptHashes,
        // embedding pages live in iframes of intranet pages
        embed
          ? [...config.cspFrameAncestors, ...config.embedFrameAncestors]
          : config.cspFrameAncestors,
        sources,
      ),
    );
    if (embed) {
      reply.removeHeader("x-frame-options");
      reply.removeHeader("cross-origin-opener-policy");
    }
    return reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(indexHtml);
  };

  app.get("/", (_request, reply) => sendIndexHtml(reply));
  // the same page under its file name: with today's headers, too
  app.get("/index.html", (_request, reply) => sendIndexHtml(reply));

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
    // only a real embedding link may be framed, nothing else of the app
    const pathname = request.url.split("?")[0];
    return sendIndexHtml(reply, EMBED_PATH_RE.test(pathname));
  });
};
