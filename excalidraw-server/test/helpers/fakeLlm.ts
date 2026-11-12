/**
 * A stand-in for the company's language model: OpenAI-compatible chat
 * completions, streamed as server-sent events.
 */
import { createServer } from "node:http";

import type { AddressInfo } from "node:net";

export interface FakeAnswer {
  /** pieces of the answer as the model streams them */
  chunks?: string[];
  /** fail with this HTTP status instead */
  status?: number;
}

export interface FakeLlm {
  url: string;
  requests: { model: string; messages: any[]; authorization?: string }[];
  answer: (answer: FakeAnswer) => void;
  close: () => Promise<void>;
}

export const startFakeLlm = async (): Promise<FakeLlm> => {
  const requests: FakeLlm["requests"] = [];
  const queue: FakeAnswer[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({
        model: parsed.model,
        messages: parsed.messages,
        authorization: request.headers.authorization,
      });
      const answer = queue.shift() || {
        chunks: ["flowchart TD", "\n  A --> B"],
      };
      if (answer.status) {
        response
          .writeHead(answer.status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "kaputt" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of answer.chunks || []) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              { index: 0, delta: { content: piece }, finish_reason: null },
            ],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    answer: (answer) => queue.push(answer),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
