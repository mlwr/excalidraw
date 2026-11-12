/**
 * Phase 4: trash, versions, search, activity, export, workspaces with
 * policies, administration (people, audit log, branding) and metrics.
 */
import { createDecipheriv } from "node:crypto";

import { strFromU8, unzipSync } from "fflate";
import { afterEach, expect, it } from "vitest";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};
const dave: FakeUser = {
  sub: "dave",
  name: "Dave Vertrieb",
  groups: ["/Vertrieb"],
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const box = (id: string, text: string, x = 0) => ({
  type: "rectangle",
  id,
  x,
  y: 0,
  width: 220,
  height: 80,
  label: { text },
});

const decrypt = (key: string, iv: string, ciphertext: string) => {
  const bytes = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-128-gcm",
    Buffer.from(key, "base64url"),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
};

const labels = (
  elements: { type: string; text?: string; isDeleted?: boolean }[],
) =>
  elements
    .filter((element) => element.type === "text" && !element.isDeleted)
    .map((element) => element.text)
    .sort();

describeWithDb("operations (phase 4)", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const app = (
      method: string,
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { cookie, origin: ORIGIN, ...headers },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const me = (await app("GET", "/api/auth/me")).json().user;
    let token: string | null = null;
    const api = async (method: string, url: string, payload?: unknown) => {
      if (!token) {
        const created = await app("POST", "/api/tokens", {
          name: "Test",
          scope: "write",
          expiresInDays: 30,
        });
        expect(created.statusCode).toBe(201);
        token = created.json().token as string;
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
    /** a scene with labelled boxes, made through the REST API */
    const scene = async (name: string, texts: string[] = [], extra = {}) => {
      const created = await api("POST", "/api/v1/scenes", {
        name,
        ...(texts.length
          ? {
              elements: texts.map((text, index) =>
                box(`b${index}`, text, index * 300),
              ),
            }
          : {}),
        ...extra,
      });
      expect(created.statusCode).toBe(201);
      return created.json().scene as { id: string; name: string };
    };
    return {
      cookie,
      app,
      api,
      scene,
      id: me.id as string,
      name: me.name as string,
    };
  };

  const events = async (type: string) =>
    env.built.ctx.db
      .selectFrom("events")
      .selectAll()
      .where("type", "=", type)
      .orderBy("id")
      .execute();

  it("keeps deleted scenes in the trash until restored or deleted for good", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const other = await person(carol);
    const plan = await owner.scene("Plan", ["Erster Schritt"]);
    expect(
      (
        await owner.app("PUT", `/api/scenes/${plan.id}/files/bild1`, PNG, {
          "content-type": "application/octet-stream",
        })
      ).statusCode,
    ).toBeLessThan(300);

    expect(
      (await owner.app("DELETE", `/api/scenes/${plan.id}`)).statusCode,
    ).toBe(204);
    const listed = (await owner.app("GET", "/api/scenes")).json().scenes;
    expect(listed.map((s: { id: string }) => s.id)).not.toContain(plan.id);
    const trash = (await owner.app("GET", "/api/scenes?view=trash")).json()
      .scenes;
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: plan.id, deletedBy: "Bob Beispiel" });
    expect(new Date(trash[0].purgeAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 86400_000,
    );
    // nobody else sees or restores it
    expect(
      (await other.app("GET", "/api/scenes?view=trash")).json().scenes,
    ).toEqual([]);
    expect(
      (await other.app("POST", `/api/scenes/${plan.id}/restore`)).statusCode,
    ).toBe(404);
    expect(
      (await other.app("DELETE", `/api/scenes/${plan.id}/purge`)).statusCode,
    ).toBe(404);

    const restored = await owner.app("POST", `/api/scenes/${plan.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect((await owner.app("GET", `/api/scenes/${plan.id}`)).statusCode).toBe(
      200,
    );
    // only deleted scenes can be purged
    expect(
      (await owner.app("DELETE", `/api/scenes/${plan.id}/purge`)).statusCode,
    ).toBe(404);

    await owner.app("DELETE", `/api/scenes/${plan.id}`);
    expect(
      (await owner.app("DELETE", `/api/scenes/${plan.id}/purge`)).statusCode,
    ).toBe(204);
    const { db } = env.built.ctx;
    expect(
      await db
        .selectFrom("scenes")
        .select("id")
        .where("id", "=", plan.id)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("blobs")
        .select("key")
        .where("key", "like", `%${plan.id}%`)
        .execute(),
    ).toEqual([]);

    // after the retention period the job empties the trash
    const old = await owner.scene("Alt");
    await owner.app("DELETE", `/api/scenes/${old.id}`);
    const fresh = await owner.scene("Frisch");
    await owner.app("DELETE", `/api/scenes/${fresh.id}`);
    await db
      .updateTable("scenes")
      .set({ deleted_at: new Date(Date.now() - 31 * 86400_000) })
      .where("id", "=", old.id)
      .execute();
    await env.built.jobs.run("trash");
    const left = (await owner.app("GET", "/api/scenes?view=trash")).json()
      .scenes;
    expect(left.map((s: { id: string }) => s.id)).toEqual([fresh.id]);

    await expect
      .poll(async () => (await events("scene.purged")).length)
      .toBe(2);
    expect((await events("scene.restored"))[0]).toMatchObject({
      scene_id: plan.id,
      actor_name: "Bob Beispiel",
    });
  });

  it("keeps versions and restores an earlier state", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const viewer = await person(carol);
    const plan = await owner.scene("Plan", ["Erster Entwurf"]);
    const { db } = env.built.ctx;
    // pretend the last snapshot is older than VERSION_INTERVAL_MINUTES
    const age = () =>
      db
        .updateTable("scene_versions")
        .set({ taken_at: new Date(Date.now() - 3600_000) })
        .execute();

    const edit = async (text: string) => {
      const response = await owner.api(
        "PATCH",
        `/api/v1/scenes/${plan.id}/elements`,
        {
          updates: [{ id: "b0", text }],
        },
      );
      expect(response.statusCode).toBe(200);
    };
    await edit("Zweiter Entwurf");
    await age();
    await edit("Dritter Entwurf");
    // within the interval: no further version
    await edit("Vierter Entwurf");

    await owner.app("PUT", `/api/scenes/${plan.id}/grants`, {
      grants: [{ type: "user", principal: viewer.id, role: "viewer" }],
    });
    const list = (
      await viewer.app("GET", `/api/scenes/${plan.id}/versions`)
    ).json();
    expect(list.canRestore).toBe(false);
    expect(list.current).toMatchObject({ savedBy: "Bob Beispiel" });
    expect(list.versions).toHaveLength(2);
    expect(list.versions[0]).toMatchObject({
      savedBy: "Bob Beispiel",
      reason: "auto",
    });

    const oldest = list.versions[list.versions.length - 1];
    const { key } = (await viewer.app("GET", `/api/scenes/${plan.id}`)).json();
    const version = (
      await viewer.app("GET", `/api/scenes/${plan.id}/versions/${oldest.id}`)
    ).json();
    expect(labels(decrypt(key, version.iv, version.ciphertext))).toEqual([
      "Erster Entwurf",
    ]);
    expect(
      (
        await viewer.app(
          "POST",
          `/api/scenes/${plan.id}/versions/${oldest.id}/restore`,
        )
      ).statusCode,
    ).toBe(403);
    // versions of other scenes are not reachable through this one
    const elsewhere = await owner.scene("Anderes", ["x"]);
    expect(
      (
        await owner.app(
          "GET",
          `/api/scenes/${elsewhere.id}/versions/${oldest.id}`,
        )
      ).statusCode,
    ).toBe(404);

    const restored = await owner.app(
      "POST",
      `/api/scenes/${plan.id}/versions/${oldest.id}/restore`,
    );
    expect(restored.statusCode).toBe(200);
    const content = (
      await owner.api("GET", `/api/v1/scenes/${plan.id}/content`)
    ).json();
    expect(labels(content.elements)).toEqual(["Erster Entwurf"]);
    // the replaced state stays in the history
    const after = (
      await owner.app("GET", `/api/scenes/${plan.id}/versions`)
    ).json();
    expect(after.canRestore).toBe(true);
    expect(after.versions[0].reason).toBe("restore");
    const replaced = (
      await owner.app(
        "GET",
        `/api/scenes/${plan.id}/versions/${after.versions[0].id}`,
      )
    ).json();
    expect(labels(decrypt(key, replaced.iv, replaced.ciphertext))).toEqual([
      "Vierter Entwurf",
    ]);

    // old versions go after VERSION_RETENTION_DAYS
    await db
      .updateTable("scene_versions")
      .set({ created_at: new Date(Date.now() - 91 * 86400_000) })
      .where("id", "=", oldest.id)
      .execute();
    await env.built.jobs.run("versions");
    const thinned = (
      await owner.app("GET", `/api/scenes/${plan.id}/versions`)
    ).json();
    expect(thinned.versions.map((v: { id: string }) => v.id)).not.toContain(
      oldest.id,
    );
    expect(await events("scene.version_restored")).toHaveLength(1);
  });

  it("finds scenes by name, drawn text and comments, only where allowed", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const stranger = await person(carol);
    const plan = await owner.scene("Projektplan", ["Urlaubsantrag prüfen"]);
    await owner.scene("Notizen", ["Kantine"]);
    await stranger.scene("Geheim", ["Urlaubsplanung Vorstand"]);
    await env.built.jobs.run("search");

    const found = (await owner.app("GET", "/api/search?q=urlaub")).json();
    expect(found.results.map((s: { id: string }) => s.id)).toEqual([plan.id]);
    expect(found.results[0].snippet).toEqual({
      kind: "drawing",
      text: "Urlaubsantrag prüfen",
    });
    // by name, too, and several words must all occur
    expect(
      (await owner.app("GET", "/api/search?q=projekt"))
        .json()
        .results.map((s: { id: string }) => s.id),
    ).toEqual([plan.id]);
    expect(
      (await owner.app("GET", "/api/search?q=urlaub kantine")).json().total,
    ).toBe(0);
    expect(
      (await stranger.app("GET", "/api/search?q=urlaub"))
        .json()
        .results.map((s: { name: string }) => s.name),
    ).toEqual(["Geheim"]);

    // comments are searchable after the indexer ran again
    const thread = await owner.app("POST", `/api/scenes/${plan.id}/comments`, {
      text: "Budget bis Freitag freigeben",
      x: 10,
      y: 10,
    });
    expect(thread.statusCode).toBe(201);
    await expect
      .poll(async () => {
        await env.built.jobs.run("search");
        return (await owner.app("GET", "/api/search?q=budget")).json().results;
      })
      .toEqual([
        expect.objectContaining({
          id: plan.id,
          snippet: { kind: "comment", text: "Budget bis Freitag freigeben" },
        }),
      ]);

    // the index holds keyed hashes, no words
    const row = await env.built.ctx.db
      .selectFrom("scene_search")
      .selectAll()
      .where("scene_id", "=", plan.id)
      .executeTakeFirstOrThrow();
    expect(row.tokens.length).toBeGreaterThan(10);
    expect(JSON.stringify(row)).not.toMatch(/urlaub|budget/i);

    // the REST API searches too
    const viaApi = (await owner.api("GET", "/api/v1/search?q=Freitag")).json();
    expect(viaApi.results.map((s: { id: string }) => s.id)).toEqual([plan.id]);
  });

  it("shows the activity of scenes someone can see", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const colleague = await person(carol);
    const mine = await owner.scene("Meins", ["a"]);
    const theirs = await colleague.scene("Fremd", ["b"]);
    for (const text of ["c", "d"]) {
      await owner.api("PATCH", `/api/v1/scenes/${mine.id}/elements`, {
        updates: [{ id: "b0", text }],
      });
    }
    const feed = async () =>
      (await owner.app("GET", "/api/activity")).json().events as {
        type: string;
        scene: { id: string; name: string; available: boolean } | null;
        actor: { name: string } | null;
        details: { count?: number };
      }[];
    // saves of one person within half an hour are one entry (creating
    // through the API with content counts as the first save)
    await expect
      .poll(
        async () =>
          (await feed()).find((event) => event.type === "scene.edited")?.details
            .count,
      )
      .toBe(3);
    expect(
      (await feed()).filter((event) => event.type === "scene.edited"),
    ).toHaveLength(1);
    expect((await feed()).every((event) => event.scene?.id !== theirs.id)).toBe(
      true,
    );

    await colleague.app("PUT", `/api/scenes/${theirs.id}/grants`, {
      grants: [{ type: "user", principal: owner.id, role: "viewer" }],
    });
    await expect
      .poll(async () =>
        (await feed())
          .filter((event) => event.scene?.id === theirs.id)
          .map((event) => event.type),
      )
      .toEqual(expect.arrayContaining(["scene.created", "share.scene_grants"]));
    const created = (await feed()).find(
      (event) =>
        event.type === "scene.created" && event.scene?.id === theirs.id,
    );
    expect(created).toMatchObject({
      actor: { name: "Carol IT" },
      scene: { name: "Fremd", available: true },
    });
  });

  it("exports everything someone may see as a ZIP", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const colleague = await person(carol);
    await owner.scene("Plan", ["eins"]);
    await owner.scene("Plan", ["zwei"]);
    const shared = await colleague.scene("Ablauf/Prozess", ["drei"]);
    await colleague.scene("Privat", ["vier"]);
    await colleague.app("PUT", `/api/scenes/${shared.id}/grants`, {
      grants: [{ type: "user", principal: owner.id, role: "viewer" }],
    });

    const response = await owner.app("GET", "/api/export");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    const files = unzipSync(new Uint8Array(response.rawPayload));
    expect(Object.keys(files).sort()).toEqual([
      "Meine Szenen/Plan (2).excalidraw",
      "Meine Szenen/Plan.excalidraw",
      "Mit mir geteilt/Ablauf_Prozess.excalidraw",
      "manifest.json",
    ]);
    const drawing = JSON.parse(
      strFromU8(files["Mit mir geteilt/Ablauf_Prozess.excalidraw"]),
    );
    expect(drawing.type).toBe("excalidraw");
    expect(labels(drawing.elements)).toEqual(["drei"]);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.scenes).toHaveLength(3);
    expect(manifest.scenes[0].url).toMatch(`${ORIGIN}/s/`);
    await expect
      .poll(async () => (await events("workspace.exported")).length)
      .toBe(1);

    // through the API as well
    const viaApi = await owner.api("GET", "/api/v1/export");
    expect(viaApi.statusCode).toBe(200);
    expect(
      Object.keys(unzipSync(new Uint8Array(viaApi.rawPayload))),
    ).toHaveLength(4);
  });

  it("runs several workspaces with members and policies", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const lead = await person(bob);
    const member = await person(dave);
    const outsider = await person(carol);

    expect(
      (await lead.app("POST", "/api/admin/workspaces", { name: "Nein" }))
        .statusCode,
    ).toBe(403);
    const created = await admin.app("POST", "/api/admin/workspaces", {
      name: "Vertrieb Süd",
    });
    expect(created.statusCode).toBe(201);
    const space = created.json().workspace;
    expect(space).toMatchObject({
      slug: "vertrieb-sud",
      openToAll: false,
      isDefault: false,
    });
    expect(
      (
        await admin.app("POST", "/api/admin/workspaces", {
          name: "X",
          slug: "vertrieb-sud",
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (
        await admin.app("PUT", `/api/admin/workspaces/${space.id}/members`, {
          members: [
            { type: "group", principal: "/Vertrieb", role: "member" },
            { type: "user", principal: lead.id, role: "admin" },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const view = async (who: typeof lead) =>
      who.app("GET", `/api/workspace?workspace=${space.slug}`);
    expect((await view(member)).json().workspace.access).toBe("member");
    expect((await view(lead)).json().workspace.access).toBe("admin");
    expect((await view(outsider)).statusCode).toBe(404);
    expect(
      (await member.app("GET", "/api/workspace"))
        .json()
        .workspaces.map((w: { slug: string }) => w.slug),
    ).toEqual(["default", "vertrieb-sud"]);
    // a workspace admin runs only their workspace
    const administered = (
      await lead.app("GET", "/api/admin/workspaces")
    ).json();
    expect(administered.workspaces.map((w: { id: string }) => w.id)).toEqual([
      space.id,
    ]);
    expect(administered.isAppAdmin).toBe(false);
    expect(
      (
        await lead.app("PATCH", `/api/admin/workspaces/${space.id}`, {
          openToAll: true,
        })
      ).statusCode,
    ).toBe(403);

    // team collections in the new workspace, created by members
    const team = await member.app("POST", "/api/collections", {
      name: "Angebote",
      workspaceId: space.id,
    });
    expect(team.statusCode).toBe(201);
    const scene = (
      await member.app("POST", "/api/scenes", {
        name: "Angebot Müller",
        collectionId: team.json().id,
      })
    ).json().scene;
    // the workspace admin manages the team collections
    expect(
      (await lead.app("GET", `/api/collections/${team.json().id}/grants`))
        .statusCode,
    ).toBe(200);

    const link = (
      await member.app("POST", `/api/scenes/${scene.id}/read-link`)
    ).json();
    await member.app("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "user", principal: outsider.id, role: "viewer" }],
    });
    expect(
      (await outsider.app("GET", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(200);

    const patched = await lead.app(
      "PATCH",
      `/api/admin/workspaces/${space.id}`,
      {
        policies: {
          readLinks: false,
          directSharing: false,
          collectionCreation: "admins",
          export: false,
          trashRetentionDays: 7,
        },
      },
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().workspace.policies).toEqual({
      readLinks: false,
      directSharing: false,
      collectionCreation: "admins",
      export: false,
      trashRetentionDays: 7,
    });
    // what exists stops working
    const token = String(link.url).split("/").pop();
    expect(
      (await outsider.app("GET", `/api/read-links/${token}`)).statusCode,
    ).toBe(404);
    expect(
      (await outsider.app("GET", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(404);
    // and nothing new is allowed
    expect(
      (await member.app("POST", `/api/scenes/${scene.id}/read-link`))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await member.app("PUT", `/api/scenes/${scene.id}/grants`, {
          grants: [{ type: "user", principal: outsider.id, role: "viewer" }],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await member.app("POST", "/api/collections", {
          name: "Neu",
          workspaceId: space.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await member.app("GET", `/api/export?workspace=${space.slug}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await lead.app("GET", `/api/export?workspace=${space.slug}`)).statusCode,
    ).toBe(200);
    // the default workspace keeps its own policies
    expect(
      (await member.app("GET", "/api/workspace")).json().workspace.policies
        .readLinks,
    ).toBe(true);
    expect(
      (
        await lead.app("PATCH", `/api/admin/workspaces/${space.id}`, {
          policies: { trashRetentionDays: 0 },
        })
      ).statusCode,
    ).toBe(400);

    // only empty workspaces can go
    expect(
      (await admin.app("DELETE", `/api/admin/workspaces/${space.id}`))
        .statusCode,
    ).toBe(409);
    const empty = (
      await admin.app("POST", "/api/admin/workspaces", { name: "Leer" })
    ).json().workspace;
    expect(
      (await admin.app("DELETE", `/api/admin/workspaces/${empty.id}`))
        .statusCode,
    ).toBe(204);
    expect((await events("workspace.updated"))[0].data).toMatchObject({
      policies: { readLinks: false },
    });
  });

  it("lets app admins manage people, the audit log and branding", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const successor = await person(bob);
    const leaver = await person(carol);
    const kept = await leaver.scene("Übergabe", ["Notizen"]);
    await leaver.api("GET", "/api/v1/me"); // creates a token

    for (const url of [
      "/api/admin/users",
      "/api/admin/audit",
      "/api/admin/stats",
    ]) {
      expect((await successor.app("GET", url)).statusCode).toBe(403);
    }
    const users = (await admin.app("GET", "/api/admin/users?q=carol")).json()
      .users;
    expect(users).toEqual([
      expect.objectContaining({
        id: leaver.id,
        name: "Carol IT",
        activeTokens: 1,
      }),
    ]);

    // disabling ends sessions and tokens at once
    expect(
      (await admin.app("POST", `/api/admin/users/${leaver.id}/disable`))
        .statusCode,
    ).toBe(200);
    expect((await leaver.app("GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await leaver.api("GET", "/api/v1/me")).statusCode).toBe(401);
    expect(
      (await admin.app("POST", `/api/admin/users/${admin.id}/disable`))
        .statusCode,
    ).toBe(400);

    // removal: personal scenes go to the successor, the name disappears
    const erased = await admin.app(
      "POST",
      `/api/admin/users/${leaver.id}/erase`,
      {
        successorId: successor.id,
      },
    );
    expect(erased.statusCode).toBe(200);
    expect(erased.json()).toEqual({ moved: 1, trashed: 0 });
    const inherited = (
      await successor.app("GET", `/api/scenes/${kept.id}`)
    ).json();
    expect(inherited.scene ?? inherited).toBeTruthy();
    expect(
      (await successor.app("GET", `/api/scenes/${kept.id}`)).statusCode,
    ).toBe(200);
    const row = await env.built.ctx.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", leaver.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: "Gelöschte Person",
      email: null,
      groups: [],
    });
    expect(row.erased_at).not.toBeNull();
    await expect
      .poll(async () =>
        (
          await env.built.ctx.db
            .selectFrom("events")
            .select("actor_name")
            .where("actor_id", "=", leaver.id)
            .execute()
        ).map((event) => event.actor_name),
      )
      .not.toContain("Carol IT");
    expect(
      (await admin.app("POST", `/api/admin/users/${leaver.id}/enable`))
        .statusCode,
    ).toBe(400);
    // events about the person lose the name too
    const traces = await env.built.ctx.db
      .selectFrom("events")
      .select(["data", "target", "actor_name"])
      .where((eb) =>
        eb.or([eb("target", "=", leaver.id), eb("actor_id", "=", leaver.id)]),
      )
      .execute();
    expect(traces.length).toBeGreaterThan(1);
    expect(JSON.stringify(traces)).not.toContain("Carol");

    // audit log: filter by type prefix, page, and download as CSV
    await expect
      .poll(async () =>
        (await admin.app("GET", "/api/admin/audit?type=admin."))
          .json()
          .events.map((event: { type: string }) => event.type),
      )
      .toEqual(["admin.user_erased", "admin.user_disabled"]);
    const logins = (
      await admin.app("GET", "/api/admin/audit?type=auth.login")
    ).json();
    expect(logins.events.length).toBeGreaterThanOrEqual(3);
    expect(
      (await admin.app("GET", "/api/admin/audit?type=DROP TABLE")).statusCode,
    ).toBe(400);
    const csv = await admin.app(
      "GET",
      "/api/admin/audit?format=csv&type=admin.",
    );
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const lines = csv.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toMatch(/^id;at;type;actor_id/);
    expect(lines).toHaveLength(3);

    // branding is public, changing it is not
    expect(
      (
        await env.built.app.inject({ method: "GET", url: "/api/branding" })
      ).json(),
    ).toEqual({
      name: "Excalidraw",
      primaryColor: null,
      links: [],
      logo: null,
    });
    const branded = await admin.app("PUT", "/api/admin/branding", {
      name: "Zeichenbrett",
      primaryColor: "#0055aa",
      links: [{ label: "Hilfe", url: "https://intranet.example/hilfe" }],
    });
    expect(branded.statusCode).toBe(200);
    for (const bad of [
      { primaryColor: "red" },
      { links: [{ label: "x", url: ["javascript", "alert(1)"].join(":") }] },
      { name: "" },
    ]) {
      expect(
        (await admin.app("PUT", "/api/admin/branding", bad)).statusCode,
      ).toBe(400);
    }
    expect(
      (await successor.app("PUT", "/api/admin/branding", { name: "Meins" }))
        .statusCode,
    ).toBe(403);
    const logo = await admin.app("PUT", "/api/admin/branding/logo", PNG, {
      "content-type": "image/png",
    });
    expect(logo.statusCode).toBe(200);
    expect(
      (
        await admin.app("PUT", "/api/admin/branding/logo", "<html></html>", {
          "content-type": "text/html",
        })
      ).statusCode,
    ).toBe(415);
    const publicBranding = (
      await env.built.app.inject({ method: "GET", url: "/api/branding" })
    ).json();
    expect(publicBranding).toMatchObject({
      name: "Zeichenbrett",
      primaryColor: "#0055aa",
      links: [{ label: "Hilfe", url: "https://intranet.example/hilfe" }],
    });
    expect(publicBranding.logo).toBeGreaterThan(0);
    const image = await env.built.app.inject({
      method: "GET",
      url: "/api/branding/logo",
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-security-policy"]).toMatch(
      /default-src 'none'/,
    );

    const stats = (await admin.app("GET", "/api/admin/stats")).json();
    expect(stats).toMatchObject({ users: 2, scenes: 1 });
  });

  it("exposes metrics for Prometheus on a port of its own", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    await owner.scene("Plan", ["Text"]);
    await env.built.jobs.run("search");
    const port = await env.built.metrics.listen("127.0.0.1", 0);
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(
      /excalidraw_http_request_duration_seconds_count\{method="POST",route="\/api\/v1\/scenes",status="2xx"\} 1/,
    );
    expect(text).toMatch(/excalidraw_events_total\{type="auth.login"\} 1/);
    expect(text).toMatch(
      /excalidraw_job_runs_total\{task="search",result="ok"\} 1/,
    );
    expect(text).toMatch(/excalidraw_users 1/);
    expect(text).toMatch(/excalidraw_scenes 1/);
    expect(text).toMatch(/excalidraw_search_pending 0/);
    expect(text).toMatch(/excalidraw_db_pool_connections\{state="total"\} \d+/);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  });
});
