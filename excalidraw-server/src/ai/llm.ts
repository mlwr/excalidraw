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
        throw new LlmError(
          502,
          `Fehler des Sprachmodells: ${String(
            json.error.message || json.error,
          ).slice(0, 200)}`,
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

/**
 * Models wrap their answer in a code fence or start with a thinking block,
 * although asked not to. The app needs the bare Mermaid code or HTML: this
 * filter removes both while streaming (it holds back what may turn out to
 * be a closing fence until it knows).
 */
export const createOutputFilter = () => {
  let head = "";
  let started = false;
  let tail = "";
  const MAX_HEAD = 400;
  // trailing whitespace, possibly after a line with only backticks
  const TAIL_RE = /(\n[ \t]*`{1,3}[ \t]*)?\s*$/;

  const emit = (text: string) => {
    const combined = tail + text;
    const held = TAIL_RE.exec(combined)?.[0] || "";
    tail = held;
    return combined.slice(0, combined.length - held.length);
  };

  /** the start of the answer without thinking block and opening fence */
  const strip = (text: string, final: boolean): string | null => {
    let rest = text.replace(/^\s+/, "");
    if (rest.startsWith("<think>")) {
      const end = rest.indexOf("</think>");
      if (end < 0) {
        return final ? "" : null;
      }
      rest = rest.slice(end + "</think>".length).replace(/^\s+/, "");
    } else if (!final && rest.length < 7 && "<think>".startsWith(rest)) {
      return null;
    }
    if (rest.startsWith("```")) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        return final ? "" : null;
      }
      rest = rest.slice(newline + 1);
    } else if (!final && "```".startsWith(rest)) {
      return null;
    }
    return rest;
  };

  return {
    push: (text: string): string => {
      if (started) {
        return emit(text);
      }
      head += text;
      const rest = strip(head, head.length > MAX_HEAD);
      if (rest === null) {
        return "";
      }
      started = true;
      head = "";
      return emit(rest);
    },
    end: (): string => {
      if (!started) {
        const rest = strip(head, true) || "";
        started = true;
        return emit(rest).replace(/\n[ \t]*```[ \t]*$/, "");
      }
      // what is held back is whitespace or a closing fence
      tail = "";
      return "";
    },
  };
};
