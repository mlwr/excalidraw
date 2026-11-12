/**
 * Phase 4 after review: jobs survive database outages, policies follow
 * scenes into other workspaces, one unreadable scene breaks neither search
 * nor export, versions and trash keep what they should, guests and
 * read-link viewers get no more than they should.
 */
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { startJobs } from "../src/jobs.js";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};

describe("background jobs", () => {
  it("keep running when the database is unreachable", async () => {
    const warnings: unknown[] = [];
    const log = {
      warn: (entry: unknown) => warnings.push(entry),
    } as unknown as FastifyBaseLogger;
    let attempts = 0;
    const pool = {
      connect: async () => {
        attempts++;
        throw new Error("connect ECONNREFUSED");
      },
    } as unknown as pg.Pool;
    let runs = 0;
    const jobs = startJobs(pool, log, [
      { name: "index", everyMs: 3600_000, run: async () => runs++ },
    ]);
    await expect(jobs.run("index")).resolves.toBeUndefined();
    // not stuck as "running": the next attempt connects again
    await expect(jobs.run("index")).resolves.toBeUndefined();
    jobs.stop();
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(runs).toBe(0);
  });
});

describeWithDb("operations after review", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const app = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const me = (await app("GET", "/api/auth/me")).json().user;
    let token: string | null = null;
    const api = async (method: string, url: string, payload?: unknown) => {
      if (!token) {
        token = (
          await app("POST", "/api/tokens", {
            name: "Test",
            scope: "write",
            expiresInDays: 30,
          })
        ).json().token as string;
      }
      return env.built.app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    };
    const scene = async (name: string, text?: string) => {
      const created = await api("POST", "/api/v1/scenes", {
        name,
        ...(text
          ? {
              elements: [
                {
                  type: "rectangle",
                  id: "a",
                  x: 0,
                  y: 0,
                  width: 200,
                  height: 80,
                  label: { text },
                },
              ],
            }
          : {}),
      });
      expect(created.statusCode).toBe(201);
      return created.json().scene as { id: string };
    };
    return { app, api, scene, id: me.id as string };
  };

  /** a workspace by the app admin, with members and policies */
  const workspaceWith = async (
    admin: Awaited<ReturnType<typeof person>>,
    name: string,
    members: { type: "user" | "group"; principal: string; role: string }[],
    policies?: Record<string, unknown>,
  ) => {
    const { workspace } = (
      await admin.app("POST", "/api/admin/workspaces", { name })
    ).json();
    await admin.app("PUT", `/api/admin/workspaces/${workspace.id}/members`, {
      members,
    });
    if (policies) {
      await admin.app("PATCH", `/api/admin/workspaces/${workspace.id}`, {
        policies,
      });
    }
    return workspace as { id: string; slug: string };
  };

  it("applies the target workspace's policies when scenes move", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const owner = await person(bob);
    const colleague = await person(carol);
    const strict = await workspaceWith(
      admin,
      "Streng",
      [{ type: "user", principal: owner.id, role: "member" }],
      { readLinks: false, directSharing: false },
    );
    const target = (
      await owner.app("POST", "/api/collections", {
        name: "Projekte",
        workspaceId: strict.id,
      })
    ).json();

    for (const via of ["app", "api"] as const) {
      const scene = await owner.scene(`Plan ${via}`, "Inhalt");
      const link = (
        await owner.app("POST", `/api/scenes/${scene.id}/read-link`)
      ).json();
      await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
        grants: [{ type: "user", principal: colleague.id, role: "editor" }],
      });
      expect(
        (await colleague.app("GET", `/api/scenes/${scene.id}`)).statusCode,
      ).toBe(200);

      const moved =
        via === "app"
          ? await owner.app("PATCH", `/api/scenes/${scene.id}`, {
              collectionId: target.id,
            })
          : await owner.api("PATCH", `/api/v1/scenes/${scene.id}`, {
              collectionId: target.id,
            });
      expect(moved.statusCode).toBe(200);

      const token = String(link.url).split("/").pop();
      expect(
        (await colleague.app("GET", `/api/read-links/${token}`)).statusCode,
      ).toBe(404);
      expect(
        (await colleague.app("GET", `/api/scenes/${scene.id}`)).statusCode,
      ).toBe(404);
      const row = await env.built.ctx.db
        .selectFrom("scenes")
        .select("read_link_token")
        .where("id", "=", scene.id)
        .executeTakeFirstOrThrow();
      expect(row.read_link_token).toBeNull();
      expect(
        await env.built.ctx.db
          .selectFrom("scene_grants")
          .select("scene_id")
          .where("scene_id", "=", scene.id)
          .execute(),
      ).toEqual([]);
    }
  });

  it("keeps search and export working around an unreadable scene", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const broken = (
      await owner.app("POST", "/api/scenes", { name: "Kaputt" })
    ).json().scene;
    expect(
      (
        await owner.app("PUT", `/api/scenes/${broken.id}/content`, {
          sceneVersion: 1,
          expectedRevision: 0,
          iv: Buffer.alloc(12, 1).toString("base64"),
          ciphertext: Buffer.from("kein Schlüssel passt").toString("base64"),
        })
      ).statusCode,
    ).toBe(200);
    const good = await owner.scene("Alpha", "Alphabet");
    await env.built.jobs.run("search");

    // the broken scene did not stop the indexer, and is not retried
    const found = (await owner.app("GET", "/api/search?q=alphab")).json();
    expect(found.results.map((s: { id: string }) => s.id)).toEqual([good.id]);
    const pending = await env.built.ctx.db
      .selectFrom("scene_search")
      .select(["scene_id", "tokens"])
      .where("scene_id", "=", broken.id)
      .executeTakeFirstOrThrow();
    expect(pending.tokens).toEqual([]);

    const byName = await owner.app("GET", "/api/search?q=kaputt");
    expect(byName.statusCode).toBe(200);
    expect(byName.json().results[0]).toMatchObject({
      id: broken.id,
      snippet: null,
    });

    const zip = await owner.app("GET", "/api/export");
    expect(zip.statusCode).toBe(200);
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.scenes.map((s: { id: string }) => s.id)).toEqual([good.id]);
    expect(manifest.unreadable).toEqual([{ id: broken.id, name: "Kaputt" }]);

    // comments added while a scene is indexed are not lost
    await owner.app("POST", `/api/scenes/${good.id}/comments`, {
      text: "Zebrastreifen",
      x: 1,
      y: 1,
    });
    await expect
      .poll(async () => {
        await env.built.jobs.run("search");
        return (await owner.app("GET", "/api/search?q=zebra")).json().total;
      })
      .toBe(1);
  });

  it("keeps the snapshot of a long unchanged scene and the feed in order", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const colleague = await person(carol);
    const old = await owner.scene("Alt", "Stand von früher");
    const { db } = env.built.ctx;
    await db
      .updateTable("scenes")
      .set({ updated_at: new Date(Date.now() - 120 * 86400_000) })
      .where("id", "=", old.id)
      .execute();
    await owner.api("PATCH", `/api/v1/scenes/${old.id}/elements`, {
      updates: [{ id: "a", text: "alles neu" }],
    });
    await env.built.jobs.run("versions");
    const versions = (
      await owner.app("GET", `/api/scenes/${old.id}/versions`)
    ).json().versions;
    expect(versions).toHaveLength(1);

    // the feed lists the latest saves first
    const other = await colleague.scene("Fremd", "x");
    await colleague.app("PUT", `/api/scenes/${other.id}/grants`, {
      grants: [{ type: "user", principal: owner.id, role: "viewer" }],
    });
    await owner.api("PATCH", `/api/v1/scenes/${old.id}/elements`, {
      updates: [{ id: "a", text: "noch einmal" }],
    });
    await expect
      .poll(async () =>
        (await owner.app("GET", "/api/activity"))
          .json()
          .events.map(
            (event: { type: string; scene: { id: string } | null }) =>
              `${event.type}:${event.scene?.id === old.id ? "alt" : "fremd"}`,
          ),
      )
      .toEqual([
        "scene.edited:alt",
        "share.scene_grants:fremd",
        "scene.edited:fremd",
        "scene.created:fremd",
        "scene.created:alt",
      ]);
  });

  it("gives guests and read-link viewers no more than shared with them", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const guest = await person(bob);
    const reader = await person(carol);
    const closed = await workspaceWith(admin, "Geschlossen", []);
    const team = (
      await admin.app("POST", "/api/collections", {
        name: "Intern",
        workspaceId: closed.id,
      })
    ).json();
    const shared = (
      await admin.app("POST", "/api/scenes", {
        name: "Für Bob",
        collectionId: team.id,
      })
    ).json().scene;
    await admin.app("PUT", `/api/scenes/${shared.id}/grants`, {
      grants: [{ type: "user", principal: guest.id, role: "viewer" }],
    });

    // searching and exporting as a guest creates nothing there
    expect(
      (await guest.app("GET", `/api/search?workspace=${closed.slug}&q=bob`))
        .statusCode,
    ).toBe(200);
    expect(
      (await guest.app("GET", `/api/export?workspace=${closed.slug}`))
        .statusCode,
    ).toBe(200);
    expect(
      (await guest.api("GET", `/api/v1/search?workspace=${closed.slug}&q=bob`))
        .statusCode,
    ).toBe(200);
    // the dashboard of the workspace works for guests, too
    for (const view of ["recent", "shared", "trash"]) {
      expect(
        (
          await guest.app(
            "GET",
            `/api/scenes?view=${view}&workspace=${closed.slug}`,
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (await guest.app("GET", `/api/activity?workspace=${closed.slug}`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await guest.app(
          "GET",
          `/api/scenes?view=shared&workspace=${closed.slug}`,
        )
      )
        .json()
        .scenes.map((scene: { id: string }) => scene.id),
    ).toEqual([shared.id]);
    expect(
      await env.built.ctx.db
        .selectFrom("collections")
        .select("id")
        .where("workspace_id", "=", closed.id)
        .where("owner_id", "=", guest.id)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await guest.app("POST", "/api/scenes", {
          name: "Eingeschmuggelt",
          workspaceId: closed.id,
        })
      ).statusCode,
    ).toBe(403);

    // a read-only link shows the scene, not its history
    const plan = await guest.scene("Plan", "Entwurf");
    await guest.api("PATCH", `/api/v1/scenes/${plan.id}/elements`, {
      updates: [{ id: "a", text: "geheim entfernt" }],
    });
    const link = (
      await guest.app("POST", `/api/scenes/${plan.id}/read-link`)
    ).json();
    const token = String(link.url).split("/").pop();
    expect(
      (await reader.app("GET", `/api/read-links/${token}`)).statusCode,
    ).toBe(200);
    expect((await reader.app("GET", `/api/scenes/${plan.id}`)).statusCode).toBe(
      200,
    );
    expect(
      (await reader.app("GET", `/api/scenes/${plan.id}/versions`)).statusCode,
    ).toBe(403);
    expect(
      (await guest.app("GET", `/api/scenes/${plan.id}/versions`)).json()
        .versions,
    ).toHaveLength(1);
  });

  it("restores scenes of a removed person and purges only the trash", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const leaver = await person(carol);
    const kept = await leaver.scene("Nachlass", "Wichtig");
    const erased = await admin.app(
      "POST",
      `/api/admin/users/${leaver.id}/erase`,
      {},
    );
    expect(erased.json()).toEqual({ moved: 0, trashed: 1 });

    const trash = (await admin.app("GET", "/api/scenes?view=trash")).json()
      .scenes;
    expect(trash.map((s: { id: string }) => s.id)).toEqual([kept.id]);
    const restored = await admin.app("POST", `/api/scenes/${kept.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().scene.collection.name).toBe("Meine Szenen");
    expect((await admin.app("GET", `/api/scenes/${kept.id}`)).statusCode).toBe(
      200,
    );

    // a scene that is back from the trash is not purged
    expect(await env.built.ctx.lifecycle.purgeScene(kept.id)).toBe(false);
    expect(
      (await admin.app("DELETE", `/api/scenes/${kept.id}/purge`)).statusCode,
    ).toBe(404);
    expect((await admin.app("GET", `/api/scenes/${kept.id}`)).statusCode).toBe(
      200,
    );
  });
});
