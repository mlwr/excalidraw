/**
 * The server's renderer (I3: scene images for the API and the command line;
 * L3: library previews) in a process of its own, one job at a time.
 *
 * Drawing is costly and its cost depends on what users drew: rough shapes
 * grow with their size, pictures unpack to their full size. So the
 * renderer has a memory limit, every job a time limit, and a renderer that
 * exceeds either is ended (or dies) and is replaced; the server itself
 * carries on. A process, not a thread: a thread that runs out of memory in
 * one large allocation takes the whole server with it. WebAssembly memory
 * (PNG) never shrinks: a renderer that grew big is replaced after its job.
 * It gets no environment (no secrets), only scenes.
 */
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HttpError } from "../util/http.js";

import type { FontMetrics } from "../db/schema.js";
import type { ChildProcess } from "node:child_process";

export interface RenderOptions {
  format: "svg" | "png";
  /** id or name of a frame: only this frame */
  frame?: string;
  theme?: "light" | "dark";
  /** false: transparent */
  background?: boolean;
  /** pixels per scene pixel (1 to 4) */
  scale?: number;
}

/** a company font (E3) as the renderer embeds it */
export interface RenderFont {
  id: number;
  family: string;
  metrics: FontMetrics;
  woff2: Uint8Array;
}

export type RenderFailureCode =
  | "frame_not_found"
  | "too_large"
  | "too_complex"
  | "failed";

export class RenderFailure extends Error {
  constructor(public readonly code: RenderFailureCode, message: string) {
    super(message);
    this.name = "RenderFailure";
  }
}

export interface Scene {
  elements: readonly unknown[];
  files: Record<string, unknown>;
}

export interface RendererOptions {
  /** the app's fonts (STATIC_DIR/fonts); null: fonts are named, not embedded */
  fontDirectory: string | null;
  /** the company fonts, asked for before each job (cached by the caller) */
  fonts?: () => Promise<{ key: string; fonts: RenderFont[] }>;
  log?: { warn: (details: unknown, message: string) => void };
  /** longest a job may take */
  timeoutMs?: number;
  /** scene images waiting or running; more: 503 */
  maxWaiting?: number;
  /** the renderer's JavaScript heap */
  heapMb?: number;
  /** a renderer bigger than this after a job is replaced */
  maxRssBytes?: number;
}

/** next to the bundled server (image), or built from the sources */
const workerFile = () => {
  const candidates = [
    new URL("./render-worker.mjs", import.meta.url),
    new URL("../../vendor/render-worker.mjs", import.meta.url),
  ];
  const found = candidates.find((candidate) =>
    existsSync(fileURLToPath(candidate)),
  );
  if (!found) {
    throw new RenderFailure(
      "failed",
      "Der Renderer fehlt (render-worker.mjs).",
    );
  }
  return found;
};

const TOO_COMPLEX =
  "Die Szene ist zu aufwendig für ein Bild. Bitte einen Frame wählen.";

interface Job {
  id: number;
  message: Record<string, unknown>;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export const createRenderer = (options: RendererOptions) => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxWaiting = options.maxWaiting ?? 8;
  const heapMb = options.heapMb ?? 384;
  const maxRssBytes = options.maxRssBytes ?? 512 * 1024 * 1024;

  let worker: ChildProcess | null = null;
  let workerFonts = "";
  let fonts: { key: string; fonts: RenderFont[] } = { key: "", fonts: [] };
  const queue: Job[] = [];
  let running: Job | null = null;
  let timer: NodeJS.Timeout | null = null;
  let reserved = 0;
  let nextId = 1;
  let closed = false;

  const finish = (job: Job) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (running === job) {
      running = null;
    }
  };

  /** the current renderer is done for: the next job gets a new one */
  const discard = (reason: string) => {
    const current = worker;
    worker = null;
    if (current) {
      current.kill("SIGKILL");
      options.log?.warn({ reason }, "renderer replaced");
    }
  };

  const failRunning = (failure: RenderFailure) => {
    const job = running;
    if (job) {
      finish(job);
      job.reject(failure);
    }
  };

  const start = () => {
    const child = fork(fileURLToPath(workerFile()), [], {
      execArgv: [`--max-old-space-size=${heapMb}`],
      // nothing of the server's environment (secrets, database)
      env: { NODE_ENV: process.env.NODE_ENV || "production" },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.unref();
    child.channel?.unref();
    child.on("message", (data: any) => {
      const job = running;
      if (child !== worker || !job || data?.id !== job.id) {
        return;
      }
      finish(job);
      if (data.ok) {
        job.resolve(
          data.png
            ? {
                png: Buffer.from(
                  data.png.buffer,
                  data.png.byteOffset,
                  data.png.byteLength,
                ),
              }
            : { svg: data.svg as string },
        );
      } else {
        job.reject(
          new RenderFailure(
            ["frame_not_found", "too_large"].includes(data.code)
              ? data.code
              : "failed",
            data.message || "Das Bild ließ sich nicht erzeugen.",
          ),
        );
      }
      if (typeof data.rss === "number" && data.rss > maxRssBytes) {
        discard("memory");
      }
      dispatch();
    });
    child.on("error", (error) => {
      if (child !== worker) {
        return;
      }
      worker = null;
      failRunning(
        new RenderFailure("failed", "Das Bild ließ sich nicht erzeugen."),
      );
      options.log?.warn({ err: error }, "renderer failed");
      dispatch();
    });
    child.on("exit", (code, signal) => {
      if (child !== worker) {
        return;
      }
      worker = null;
      // out of memory (or killed for it): too much to draw
      failRunning(new RenderFailure("too_complex", TOO_COMPLEX));
      options.log?.warn({ code, signal }, "renderer ended");
      dispatch();
    });
    child.send({
      type: "setup",
      fontDirectory: options.fontDirectory,
      fonts: fonts.fonts,
    });
    workerFonts = fonts.key;
    return child;
  };

  const dispatch = () => {
    if (running || closed) {
      return;
    }
    const job = queue.shift();
    if (!job) {
      return;
    }
    running = job;
    try {
      worker ??= start();
    } catch (error) {
      finish(job);
      job.reject(error as Error);
      dispatch();
      return;
    }
    try {
      if (workerFonts !== fonts.key) {
        worker.send({ type: "fonts", fonts: fonts.fonts });
        workerFonts = fonts.key;
      }
      worker.send({ ...job.message, id: job.id });
    } catch (error) {
      // not plain data
      finish(job);
      job.reject(error as Error);
      dispatch();
      return;
    }
    timer = setTimeout(() => {
      if (running !== job) {
        return;
      }
      finish(job);
      job.reject(new RenderFailure("too_complex", TOO_COMPLEX));
      discard("timeout");
      dispatch();
    }, timeoutMs);
  };

  const enqueue = async <T>(message: Record<string, unknown>): Promise<T> => {
    if (closed) {
      throw new RenderFailure("failed", "Der Renderer ist beendet.");
    }
    if (options.fonts) {
      try {
        fonts = await options.fonts();
      } catch (error) {
        // without the company's fonts, text falls back
        options.log?.warn({ err: error }, "company fonts not loaded");
      }
    }
    if (closed) {
      // ended while the fonts were loading
      throw new RenderFailure("failed", "Der Renderer ist beendet.");
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({ id: nextId++, message, resolve, reject });
      dispatch();
    });
  };

  const busy = () =>
    new HttpError(
      503,
      "busy",
      "Gerade werden viele Bilder erzeugt. Bitte gleich noch einmal.",
    );

  return {
    /**
     * A place in line for a scene image, taken before the scene is read
     * (scenes and their pictures are large): when the line is full, 503.
     */
    withSlot: async <T>(
      work: (render: {
        scene: (
          scene: Scene,
          renderOptions: RenderOptions,
        ) => Promise<{ svg: string } | { png: Buffer }>;
      }) => Promise<T>,
    ): Promise<T> => {
      // a place is held from reading the scene until its image is done
      if (reserved >= maxWaiting) {
        throw busy();
      }
      reserved++;
      try {
        return await work({
          scene: (scene, renderOptions) =>
            enqueue({ type: "scene", scene, options: renderOptions }),
        });
      } finally {
        reserved--;
      }
    },

    /** a library's preview (L3), queued behind the scene images */
    preview: async (items: readonly unknown[]): Promise<string> => {
      const result = await enqueue<{ svg: string }>({
        type: "preview",
        items,
      });
      return result.svg;
    },

    close: async () => {
      closed = true;
      for (const job of queue.splice(0)) {
        job.reject(new RenderFailure("failed", "Der Renderer ist beendet."));
      }
      const current = worker;
      worker = null;
      failRunning(new RenderFailure("failed", "Der Renderer ist beendet."));
      current?.kill("SIGKILL");
    },
  };
};

export type Renderer = ReturnType<typeof createRenderer>;
