import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

/**
 * Route option: requests per minute and session, not per address (in a
 * company network many people may share one).
 */
export const perSession = (cookieName: string, name: string, max: number) => ({
  rateLimit: {
    max,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) => {
      const session = request.cookies?.[cookieName];
      return session
        ? `${name}:${createHash("sha256").update(session).digest("hex")}`
        : request.ip;
    },
  },
});
