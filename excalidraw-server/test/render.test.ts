/**
 * Scenes as SVG and PNG, and the command line tool (I3).
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { AddressInfo } from "node:net";
import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../cli/excalidraw.mjs");
const FONTS = path.resolve(here, "../../packages/excalidraw/fonts");

/** width and height from a PNG header */
const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

describeWithDb("rendering and command line", () => {
  let env: TestEnv;
  let dir: string | null = null;

  afterEach(async () => {
    await env?.close();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  /** an app directory with the editor's fonts, as in the image */
  const appDir = async () => {
    dir = await mkdtemp(path.join(tmpdir(), "excalidraw-render-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
    for (const family of ["Excalifont", "Liberation"]) {
      await mkdir(path.join(dir, "fonts", family), { recursive: true });
      await cp(path.join(FONTS, family), path.join(dir, "fonts", family), {
        recursive: true,
        filter: (source) => !source.endsWith(".ts"),
      });
    }
    return dir;
  };

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const created = await env.built.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie, origin: ORIGIN },
      payload: { name: "Doku-Pipeline", scope: "write", expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    const api = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    return { token, api };
  };

  it("renders scenes and frames as SVG and PNG for who may see them", async () => {
    env = await createTestEnv({ STATIC_DIR: await appDir() });
    const owner = await person(bob);
    const stranger = await person(alice);
    const created = await owner.api("POST", "/api/v1/scenes", {
      name: "Ablauf",
      elements: [
        {
          type: "frame",
          id: "folie1",
          name: "Folie 1",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          children: ["box"],
        },
        {
          type: "rectangle",
          id: "box",
          x: 40,
          y: 40,
          width: 200,
          height: 100,
          label: { text: "Antrag prüfen" },
        },
        { type: "text", x: 600, y: 600, text: "Außerhalb" },
      ],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().scene.id as string;

    const svg = await owner.api("GET", `/api/v1/scenes/${id}/image`);
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(svg.headers["content-security-policy"]).toMatch(
      /default-src 'none'/,
    );
    expect(svg.body).toMatch(/^<svg /);
    // the font travels with the image, reduced to the characters used
    expect(svg.body).toContain("data:font/woff2;base64,");
    expect(svg.body).toContain("Antrag prüfen");

    const png = await owner.api(
      "GET",
      `/api/v1/scenes/${id}/image?format=png&scale=2`,
    );
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    const whole = pngSize(png.rawPayload);

    const frame = await owner.api(
      "GET",
      `/api/v1/scenes/${id}/image?format=png&frame=${encodeURIComponent(
        "Folie 1",
      )}`,
    );
    expect(frame.statusCode).toBe(200);
    const framed = pngSize(frame.rawPayload);
    expect(framed.width).toBe(400);
    expect(framed.height).toBe(300);
    expect(whole.width).toBeGreaterThan(framed.width * 2);

    expect(
      (await owner.api("GET", `/api/v1/scenes/${id}/image?frame=Nope`)).json()
        .error,
    ).toBe("frame_not_found");
    for (const bad of [
      "format=gif",
      "scale=9",
      "theme=blue",
      "background=no",
    ]) {
      expect(
        (await owner.api("GET", `/api/v1/scenes/${id}/image?${bad}`))
          .statusCode,
      ).toBe(400);
    }
    // no access, no image
    expect(
      (await stranger.api("GET", `/api/v1/scenes/${id}/image`)).statusCode,
    ).toBe(404);

    const cli = await env.built.app.inject({
      method: "GET",
      url: "/api/v1/cli",
    });
    expect(cli.statusCode).toBe(200);
    expect(cli.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(cli.body).toContain("EXCALIDRAW_TOKEN");
  });

  it("works from the command line, as documentation pipelines use it", async () => {
    env = await createTestEnv({ STATIC_DIR: await appDir() });
    const owner = await person(bob);
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = env.built.app.server.address() as AddressInfo;
    const cli = (...args: string[]) =>
      run(process.execPath, [CLI, ...args], {
        cwd: dir!,
        env: {
          ...process.env,
          EXCALIDRAW_URL: `http://127.0.0.1:${port}`,
          EXCALIDRAW_TOKEN: owner.token,
        },
      });

    expect((await cli("whoami")).stdout).toMatch(/Bob/);
    const { stdout: help } = await cli("--help");
    expect(help).toContain("render SZENE");

    // a drawing from somewhere else comes in, is listed, goes out again
    const template = (
      await owner.api("POST", "/api/v1/scenes", {
        name: "Vorlage",
        elements: [{ type: "ellipse", x: 0, y: 0, width: 120, height: 80 }],
      })
    ).json().scene;
    const drawing = (
      await owner.api("GET", `/api/v1/scenes/${template.id}/content`)
    ).json();
    await writeFile(
      path.join(dir!, "netz.excalidraw"),
      JSON.stringify(drawing),
    );
    const imported = JSON.parse(
      (await cli("import", "netz.excalidraw", "--json")).stdout,
    );
    expect(imported.name).toBe("netz");

    const listed = JSON.parse((await cli("scenes", "--json")).stdout);
    expect(listed.map((scene: { name: string }) => scene.name).sort()).toEqual([
      "Vorlage",
      "netz",
    ]);

    // a pasted link works as well as the id
    await cli(
      "render",
      `https://excalidraw.intranet.example/s/${imported.id}`,
      "-o",
      "netz.png",
    );
    const png = await readFile(path.join(dir!, "netz.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    await cli("render", imported.id, "--theme", "dark", "-o", "netz.svg");
    expect(await readFile(path.join(dir!, "netz.svg"), "utf8")).toMatch(
      /^<svg /,
    );

    await cli("export", imported.id, "-o", "zurueck.excalidraw");
    const exported = JSON.parse(
      await readFile(path.join(dir!, "zurueck.excalidraw"), "utf8"),
    );
    expect(exported.elements).toHaveLength(1);

    // errors: a message and an exit code, no stack trace
    const failed = await cli("render", "nicht-da-1234").catch((error) => error);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/^excalidraw: /);
    const usage = await cli("export").catch((error) => error);
    expect(usage.code).toBe(2);
  });
});
