/**
 * Intranet fork: which web pages scenes may embed (E2). The app admins
 * allow internal hosts ("wiki.intranet.example", "*.intranet.example");
 * the external services the editor knows (YouTube, Figma, ...) only if
 * they switched them on. The server's Content-Security-Policy lists the
 * same hosts, so the browser enforces it too.
 */
import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";

export interface EmbedSettings {
  allowedHosts: string[];
  external: boolean;
}

/** whether an https URL's host and port match an allowed host pattern */
export const matchesHostPattern = (url: URL, pattern: string) => {
  const [host, port = ""] = pattern.split(":");
  if (url.protocol !== "https:" || url.port !== port) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return host.startsWith("*.")
    ? hostname.endsWith(host.slice(1)) && hostname.length > host.length - 1
    : hostname === host;
};

/**
 * Services the editor shows through their own scripts (X/Twitter posts,
 * Reddit posts, GitHub gists): the CSP allows no scripts from elsewhere, so
 * they would only ever show as an empty frame.
 */
const SCRIPT_EMBEDS =
  /(^|\.)(twitter\.com|x\.com|reddit\.com|gist\.github\.com)$/;

/**
 * The editor's validateEmbeddable: true for allowed internal pages; for
 * everything else false, or, with external services switched on, the
 * editor's own list of known services decides (except the services above).
 */
export const createEmbedValidator = (
  settings: EmbedSettings,
): NonNullable<ExcalidrawProps["validateEmbeddable"]> => {
  return (link: string) => {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return false;
    }
    if (
      settings.allowedHosts.some((pattern) => matchesHostPattern(url, pattern))
    ) {
      return true;
    }
    if (!settings.external || SCRIPT_EMBEDS.test(url.hostname.toLowerCase())) {
      return false;
    }
    return undefined;
  };
};
