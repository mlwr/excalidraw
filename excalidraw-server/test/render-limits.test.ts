/**
 * The server's renderer under load and abuse (Phase 6 review): it runs in a
 * thread of its own with limits on time and memory, draws only elements of
 * sane size and pictures it can unpack, and writes well-formed XML. Inputs
 * from the API and libraries are bounded where they come in.
 */
import { afterEach, describe, expect, it } from "vitest";

import { imageFitsPng, rasterSize } from "../elements/images.js";
import { createRenderer, RenderFailure } from "../src/render/renderer.js";
import { HttpError } from "../src/util/http.js";

import { bob, createTestEnv, describeWithDb, ORIGIN } from "./helpers/setup.js";

import type { Renderer } from "../src/render/renderer.js";
import type { TestEnv } from "./helpers/setup.js";

const rectangle = (id: string, size: number, extra = {}) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: size,
  height: size,
  strokeColor: "#1e1e1e",
  backgroundColor: "#ffc9c9",
  fillStyle: "hachure",
  strokeWidth: 1,
  roughness: 1,
  ...extra,
});

/** a PNG that is only a header: it claims a size, nothing else */
const pngHeader = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
};

/** a real 2 × 2 PNG */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWP4z8DwHwyBNEgMSIOFAPh0B/lqVsRjAAAAAElFTkSuQmCC";

const imageScene = (dataURL: string) => ({
  elements: [
    {
      id: "picture",
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      fileId: "file1",
      status: "saved",
      scale: [1, 1],
    },
  ],
  files: {
    file1: {
      id: "file1",
      mimeType: "image/png",
      dataURL,
      created: 1,
    },
  },
});

describe("the renderer's own process", () => {
  let renderer: Renderer | null = null;

  afterEach(async () => {
    await renderer?.close();
    renderer = null;
  });

  const render = (
    scene: { elements: unknown[]; files?: Record<string, unknown> },
    format: "svg" | "png" = "svg",
  ) =>
    renderer!.withSlot((slot) =>
      slot.scene(
        { elements: scene.elements, files: scene.files || {} },
        {
          format,
        },
      ),
    );

  it("ends a job that takes too long, and carries on with the next", async () => {
    renderer = createRenderer({ fontDirectory: null, timeoutMs: 1500 });
    // fine for the editor, but costly in bulk: rough fills of 100 000 px
    const heavy = Array.from({ length: 40 }, (_, i) =>
      rectangle(`big${i}`, 100_000),
    );
    const started = Date.now();
    const failure = await render({ elements: heavy }).catch((error) => error);
    expect(failure).toBeInstanceOf(RenderFailure);
    expect(failure.code).toBe("too_complex");
    expect(Date.now() - started).toBeLessThan(10_000);

    const next = await render({ elements: [rectangle("small", 100)] });
    expect("svg" in next && next.svg).toMatch(/^<svg /);
  }, 30_000);

  it("survives a renderer that runs out of memory, and carries on", async () => {
    // a thread would have taken the whole process with it here
    renderer = createRenderer({ fontDirectory: null, heapMb: 48 });
    const failure = await render({
      elements: [rectangle("r", 100)],
      files: {
        big: {
          id: "big",
          mimeType: "image/png",
          dataURL: `data:image/png;base64,${"A".repeat(120 * 1024 * 1024)}`,
        },
      },
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(RenderFailure);
    expect(["too_complex", "failed"]).toContain(failure.code);

    const next = await render({ elements: [rectangle("small", 100)] });
    expect("svg" in next && next.svg).toMatch(/^<svg /);
  }, 60_000);

  it("leaves out elements of absurd size instead of drawing them", async () => {
    renderer = createRenderer({ fontDirectory: null, timeoutMs: 5000 });
    // drawn before this, an ellipse this size took minutes and all memory
    const result = await render({
      elements: [
        rectangle("ok", 100),
        { ...rectangle("huge", 1e15), type: "ellipse" },
        rectangle("nan", 100, { x: "1e400" }),
      ],
    });
    expect("svg" in result && result.svg).toMatch(/^<svg /);
  }, 20_000);

  it("says busy when too many images wait", async () => {
    renderer = createRenderer({ fontDirectory: null, maxWaiting: 1 });
    let release!: () => void;
    const holding = renderer.withSlot(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const second = await renderer
      .withSlot(async () => "drawn")
      .catch((error) => error);
    expect(second).toBeInstanceOf(HttpError);
    expect(second.statusCode).toBe(503);
    release();
    await holding;
    expect(await renderer.withSlot(async () => "drawn")).toBe("drawn");
  });

  it("does not unpack pictures that claim to be huge", async () => {
    renderer = createRenderer({ fontDirectory: null, timeoutMs: 10_000 });
    const huge = `data:image/png;base64,${pngHeader(20_000, 20_000).toString(
      "base64",
    )}`;
    const png = await render(imageScene(huge), "png");
    expect("png" in png && png.png.subarray(1, 4).toString()).toBe("PNG");
    const fine = await render(
      imageScene(`data:image/png;base64,${TINY_PNG}`),
      "png",
    );
    expect("png" in fine).toBe(true);
    // only pictures from inside the scene, never addresses
    const svg = await render(imageScene("https://elsewhere.example/a.png"));
    expect("svg" in svg && svg.svg).not.toContain("elsewhere.example");
  }, 20_000);

  it("writes well-formed XML, whatever links and texts contain", async () => {
    renderer = createRenderer({ fontDirectory: null, timeoutMs: 10_000 });
    const scene = {
      elements: [
        rectangle("linked", 100, {
          link: 'https://wiki.example/?a=<b>&c="d"',
          fillStyle: "solid",
        }),
        {
          id: "label",
          type: "text",
          x: 0,
          y: 150,
          width: 200,
          height: 25,
          text: '1 < 2 & \u0007 "Zitat"',
          originalText: '1 < 2 & \u0007 "Zitat"',
          fontSize: 20,
          fontFamily: 5,
          textAlign: "left",
          verticalAlign: "top",
          lineHeight: 1.25,
        },
      ],
    };
    const svg = await render(scene);
    expect("svg" in svg).toBe(true);
    const text = (svg as { svg: string }).svg;
    // no "<" inside an attribute value, no control characters
    expect(text).not.toMatch(/="[^"]*</);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\u0007/);
    expect(text).toContain("&lt;b&gt;");
    // resvg reads XML strictly: before, such a link broke the PNG
    const png = await render(scene, "png");
    expect("png" in png).toBe(true);
  }, 20_000);
});

describe("image sizes from the first bytes", () => {
  it("reads PNG, GIF, JPEG and WebP headers", () => {
    expect(rasterSize(pngHeader(300, 200))).toEqual({
      width: 300,
      height: 200,
    });
    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(640, 6);
    gif.writeUInt16LE(480, 8);
    expect(rasterSize(gif)).toEqual({ width: 640, height: 480 });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x03, 0x00, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(rasterSize(jpeg)).toEqual({ width: 1280, height: 768 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(4999, 24, 3);
    webp.writeUIntLE(2999, 27, 3);
    expect(rasterSize(webp)).toEqual({ width: 5000, height: 3000 });
    expect(rasterSize(Buffer.from("not a picture"))).toBeNull();
  });

  it("lets only pictures into PNGs that unpack to a sane size", () => {
    const data = (type: string, bytes: Buffer) =>
      `data:${type};base64,${bytes.toString("base64")}`;
    expect(imageFitsPng(data("image/png", pngHeader(4000, 4000)))).toBe(true);
    expect(imageFitsPng(data("image/png", pngHeader(20_000, 20_000)))).toBe(
      false,
    );
    // an SVG picture that wraps a huge one
    const wrapper = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${data(
      "image/png",
      pngHeader(30_000, 30_000),
    )}"/></svg>`;
    expect(
      imageFitsPng(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(wrapper)}`,
      ),
    ).toBe(false);
    expect(
      imageFitsPng(
        `data:image/svg+xml,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>',
        )}`,
      ),
    ).toBe(true);
    expect(imageFitsPng("data:image/bmp;base64,Qk0=")).toBe(false);
  });
});

describeWithDb("bounds where elements come in", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  it("refuses absurd sizes in API imports and library items", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const app = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "POST",
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const created = await app("POST", "/api/tokens", {
      name: "Grenzen",
      scope: "write",
      expiresInDays: 1,
    });
    const token = created.json().token as string;
    const api = (url: string, payload: unknown) =>
      env.built.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: payload as Record<string, unknown>,
      });

    const imported = await api("/api/v1/scenes", {
      name: "Import",
      content: {
        elements: [{ ...rectangle("huge", 1e15), type: "ellipse" }],
      },
    });
    expect(imported.statusCode).toBe(400);
    expect(imported.json().message).toMatch(/width ist zu groß/);
    const sane = await api("/api/v1/scenes", {
      name: "Import",
      content: { elements: [rectangle("ok", 500_000)] },
    });
    expect(sane.statusCode).toBe(201);

    const published = await app("POST", "/api/library-catalog", {
      name: "Riesig",
      libraryItems: [
        {
          id: "item",
          status: "published",
          created: 1,
          elements: [rectangle("huge", 1e6)],
        },
      ],
    });
    expect(published.statusCode).toBe(400);
    expect(published.json().error).toBe("invalid_items");
  });
});
