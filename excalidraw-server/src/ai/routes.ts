/**
 * The app's AI dialogs (text to diagram, wireframe to code) talk to these
 * routes; they stream the answer of the company's language model in the
 * format the dialogs expect (server-sent events with content deltas).
 */
import { PassThrough } from "node:stream";

import { HttpError } from "../util/http.js";
import { hasControlChars } from "../util/validate.js";
import { perSession } from "../util/rateLimit.js";

import { LlmError } from "./llm.js";
import {
  AiRefused,
  diagramToCodePrompt,
  TEXT_TO_DIAGRAM_PROMPT,
} from "./service.js";

import type { LlmMessage } from "./llm.js";
import type { AiFeature } from "./service.js";
import type { AppContext } from "../context.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_CHAT_CHARS = 60_000;
const MAX_TEXTS_CHARS = 20_000;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

const invalid = (message: string) =>
  new HttpError(400, "invalid_input", message);

const chatMessages = (value: unknown): LlmMessage[] => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MESSAGES) {
    throw invalid(`messages: 1 bis ${MAX_MESSAGES} Nachrichten.`);
  }
  let total = 0;
  const messages = value.map((item: Record<string, unknown>) => {
    const role = item?.role;
    const content = item?.content;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string" ||
      content.length > MAX_MESSAGE_CHARS
    ) {
      throw invalid("Ungültige Nachricht.");
    }
    total += content.length;
    return { role, content } as LlmMessage;
  });
  if (total > MAX_CHAT_CHARS) {
    throw invalid("Der Verlauf ist zu lang. Bitte einen neuen Chat beginnen.");
  }
  if (messages[messages.length - 1].role !== "user") {
    throw invalid("Die letzte Nachricht muss eine Frage sein.");
  }
  return messages;
};

export const registerAiRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { ai, config } = ctx;

  /** plain text: both dialogs show the body of a failed request as is */
  const refuse = (reply: FastifyReply, status: number, message: string) =>
    reply
      .code(status)
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send(message);

  const run = async (
    request: FastifyRequest,
    reply: FastifyReply,
    feature: AiFeature,
    messages: LlmMessage[],
  ) => {
    const user = request.auth!.user;
    let admitted: { limit: number; remaining: number };
    try {
      admitted = await ai.admit(user, feature);
    } catch (error) {
      if (error instanceof AiRefused) {
        return refuse(reply, error.status, error.message);
      }
      throw error;
    }
    reply
      .header("x-ratelimit-limit", String(admitted.limit))
      .header("x-ratelimit-remaining", String(admitted.remaining));

    // the browser went away: stop asking the model
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const answer = ai
      .generate(user, feature, messages, controller.signal)
      [Symbol.asyncIterator]();

    // errors before the first words become a proper HTTP error
    let first: IteratorResult<string>;
    try {
      first = await answer.next();
    } catch (error) {
      if (error instanceof LlmError) {
        request.log.warn({ status: error.status }, "AI request failed");
        return refuse(reply, error.status, error.message);
      }
      throw error;
    }

    const stream = new PassThrough();
    const send = (chunk: unknown) => {
      if (!stream.destroyed) {
        stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    };
    void (async () => {
      try {
        for (let next = first; !next.done; next = await answer.next()) {
          send({ type: "content", delta: next.value });
        }
        send({ type: "done", finishReason: "stop" });
      } catch (error) {
        if (!controller.signal.aborted) {
          request.log.warn({ err: error }, "AI answer broke off");
          send({
            type: "error",
            error: {
              message:
                error instanceof LlmError
                  ? error.message
                  : "Die Antwort des Sprachmodells brach ab.",
            },
          });
        }
      } finally {
        if (!stream.destroyed) {
          stream.end("data: [DONE]\n\n");
        }
      }
    })();
    return (
      reply
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-store")
        // ingress-nginx: pass events on at once
        .header("x-accel-buffering", "no")
        .send(stream)
    );
  };

  app.post(
    "/api/ai/text-to-diagram/chat-streaming",
    {
      preHandler: requireAuth,
      bodyLimit: 512 * 1024,
      config: perSession(config.session.cookieName, "ai", 30),
    },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const messages = chatMessages(body.messages);
      return run(request, reply, "text-to-diagram", [
        { role: "system", content: TEXT_TO_DIAGRAM_PROMPT },
        ...messages,
      ]);
    },
  );

  app.post(
    "/api/ai/diagram-to-code/generate-streaming",
    {
      preHandler: requireAuth,
      bodyLimit: MAX_IMAGE_CHARS + 512 * 1024,
      config: perSession(config.session.cookieName, "ai", 30),
    },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const texts = body.texts ?? "";
      const image = body.image;
      const theme = body.theme === "dark" ? "dark" : "light";
      if (
        typeof texts !== "string" ||
        texts.length > MAX_TEXTS_CHARS ||
        hasControlChars(texts.replace(/[\n\r\t]/g, " "))
      ) {
        throw invalid("texts: Text bis 20 000 Zeichen.");
      }
      if (
        typeof image !== "string" ||
        image.length > MAX_IMAGE_CHARS ||
        !IMAGE_RE.test(image)
      ) {
        throw invalid("image: Bild als data-URL (PNG, JPEG oder WebP).");
      }
      return run(request, reply, "diagram-to-code", [
        { role: "system", content: diagramToCodePrompt(theme) },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: texts.trim()
                ? `Texte aus der Skizze:\n${texts}`
                : "Die Skizze enthält keine Texte.",
            },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ]);
    },
  );
};
