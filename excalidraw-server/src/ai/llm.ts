/**
 * Client for the company's language model: any OpenAI-compatible
 * chat completions endpoint (vLLM, Ollama, LiteLLM, Azure OpenAI, ...),
 * streamed.
 */
export type LlmContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    )[];

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: LlmContent;
}

export interface LlmChunk {
  delta?: string;
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmOptions {
  baseUrl: URL;
  apiKey: string | null;
  model: string;
  maxTokens: number;
  signal: AbortSignal;
}

/** stream the answer of the model, chunk by chunk */
export async function* streamChat(
  options: LlmOptions,
  messages: LlmMessage[],
): AsyncGenerator<LlmChunk> {
  let response: Response;
  try {
    response = await fetch(
      `${options.baseUrl.href.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: options.maxTokens,
          temperature: 0.2,
        }),
        signal: options.signal,
      },
    );
  } catch (error) {
    if (options.signal.aborted) {
      throw error;
    }
    throw new LlmError(502, "Das Sprachmodell ist nicht erreichbar.");
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new LlmError(
      response.status === 429 ? 429 : 502,
      `Das Sprachmodell hat die Anfrage abgelehnt (${response.status}).${
        detail ? ` ${detail.slice(0, 200)}` : ""
      }`,
    );
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        return;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json?.error) {
        // gateways may echo the input in their messages: not passed on
        throw new LlmError(
          502,
          "Das Sprachmodell hat die Antwort abgebrochen.",
        );
      }
      const choice = json?.choices?.[0];
      yield {
        delta:
          typeof choice?.delta?.content === "string"
            ? choice.delta.content
            : undefined,
        finishReason: choice?.finish_reason ?? null,
        usage: json?.usage || undefined,
      };
    }
  }
}

/** reasoning blocks some models put before their answer */
const THINK_TAGS = ["<think>", "<thinking>"];

/** reasoning beyond this many characters: give up on the request */
export const MAX_THINKING_CHARS = 200_000;

/** an opening fence line longer than this is no fence line */
const MAX_FENCE_LINE = 200;

/**
 * Models wrap their answer in a code fence or start with a thinking block,
 * although asked not to. The app needs the bare Mermaid code or HTML: this
 * filter removes both while streaming (it holds back what may turn out to
 * be a closing fence until it knows). A thinking block is dropped however
 * long it is; one that never ends is an error, not an answer.
 */
export const createOutputFilter = (maxThinking = MAX_THINKING_CHARS) => {
  let state: "start" | "thinking" | "answer" = "start";
  /** start: what came so far; thinking: what may be the start of the end tag */
  let pending = "";
  let closing = "";
  let thought = 0;
  let tail = "";
  // trailing whitespace, possibly after a line with only backticks
  const TAIL_RE = /(\n[ \t]*`{1,3}[ \t]*)?\s*$/;

  const emit = (text: string) => {
    const combined = tail + text;
    const held = TAIL_RE.exec(combined)?.[0] || "";
    tail = held;
    return combined.slice(0, combined.length - held.length);
  };

  const answer = (text: string) => {
    state = "answer";
    pending = "";
    return emit(text);
  };

  /** move on as far as the text so far allows */
  const step = (final: boolean): string => {
    for (;;) {
      if (state === "answer") {
        return "";
      }
      if (state === "thinking") {
        const end = pending.indexOf(closing);
        if (end < 0) {
          const keep = Math.min(pending.length, closing.length - 1);
          thought += pending.length - keep;
          pending = pending.slice(pending.length - keep);
          if (thought > maxThinking) {
            throw new LlmError(
              502,
              "Das Sprachmodell hat zu lange überlegt. Bitte die Anfrage vereinfachen.",
            );
          }
          if (final) {
            throw new LlmError(
              502,
              "Das Sprachmodell hat nur überlegt und keine Antwort geliefert. Bitte noch einmal versuchen.",
            );
          }
          return "";
        }
        thought += end;
        pending = pending.slice(end + closing.length);
        state = "start";
        continue;
      }
      const rest = pending.replace(/^\s+/, "");
      const open = THINK_TAGS.find((tag) => rest.startsWith(tag));
      if (open) {
        state = "thinking";
        closing = `</${open.slice(1)}`;
        pending = rest.slice(open.length);
        continue;
      }
      if (!final && THINK_TAGS.some((tag) => tag.startsWith(rest))) {
        pending = rest;
        return "";
      }
      if (rest.startsWith("```")) {
        const newline = rest.indexOf("\n");
        if (newline >= 0) {
          return answer(rest.slice(newline + 1));
        }
        if (final) {
          return answer("");
        }
        if (rest.length <= MAX_FENCE_LINE) {
          pending = rest;
          return "";
        }
        return answer(rest);
      }
      if (!final && "```".startsWith(rest)) {
        pending = rest;
        return "";
      }
      return answer(rest);
    }
  };

  return {
    push: (text: string): string => {
      if (state === "answer") {
        return emit(text);
      }
      pending += text;
      return step(false);
    },
    end: (): string => {
      const rest = state === "answer" ? "" : step(true);
      // what is held back is whitespace or a closing fence
      tail = "";
      return rest;
    },
  };
};
