import type { FastifyReply } from "fastify";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

export const sendError = (
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
) =>
  reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .send({ error: code, message: message || code, ...extra });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Minimal HTML page for errors the user hits during top-level navigations
 * (login callback), where a JSON body would be useless.
 */
export const sendHtmlError = (
  reply: FastifyReply,
  statusCode: number,
  title: string,
  text: string,
  link?: { href: string; label: string },
) => {
  const linkHtml = link
    ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`
    : "";
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .header("content-type", "text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1b1b1f}` +
        `h1{font-size:1.4rem}a{color:#4a47b1}</style></head>` +
        `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(
          text,
        )}</p>${linkHtml}</body></html>`,
    );
};
