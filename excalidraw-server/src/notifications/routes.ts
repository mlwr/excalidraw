/**
 * The bell in the app: my notifications, read state, e-mail preferences.
 */
import { HttpError } from "../util/http.js";
import { queryParam } from "../util/validate.js";

import type { AppContext } from "../context.js";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

export const registerNotificationRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { notifications } = ctx;
  const options = { preHandler: requireAuth };

  app.get("/api/notifications", options, async (request, reply) => {
    const before = queryParam(
      (request.query as Record<string, unknown>).before,
    );
    if (before !== undefined && !/^\d{1,18}$/.test(before)) {
      throw new HttpError(
        400,
        "invalid_before",
        "before ist eine Benachrichtigungs-id.",
      );
    }
    reply.header("cache-control", "no-store");
    return notifications.list(request.auth!.user.id, before);
  });

  app.get("/api/notifications/unread", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { unread: await notifications.unreadCount(request.auth!.user.id) };
  });

  app.post("/api/notifications/read", options, async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    if (body.all === true) {
      await notifications.markRead(request.auth!.user.id, "all");
    } else if (
      Array.isArray(body.ids) &&
      body.ids.length <= 200 &&
      body.ids.every((id) => typeof id === "string" && /^\d{1,18}$/.test(id))
    ) {
      await notifications.markRead(request.auth!.user.id, body.ids as string[]);
    } else {
      throw new HttpError(400, "invalid_input", "ids (Liste) oder all: true.");
    }
    return { unread: await notifications.unreadCount(request.auth!.user.id) };
  });

  app.get("/api/notifications/preferences", options, async (request) => ({
    emailAvailable: notifications.emailEnabled && !!request.auth!.user.email,
    email: await notifications.getPreferences(request.auth!.user.id),
  }));

  app.put("/api/notifications/preferences", options, async (request) => {
    const email = ((request.body || {}) as Record<string, unknown>).email as
      | Record<string, unknown>
      | undefined;
    const changes: Record<string, boolean> = {};
    for (const key of ["mention", "reply", "share"] as const) {
      if (email?.[key] !== undefined) {
        if (typeof email[key] !== "boolean") {
          throw new HttpError(
            400,
            "invalid_input",
            `email.${key}: true oder false.`,
          );
        }
        changes[key] = email[key] as boolean;
      }
    }
    return {
      emailAvailable: notifications.emailEnabled && !!request.auth!.user.email,
      email: await notifications.setPreferences(request.auth!.user.id, changes),
    };
  });
};
