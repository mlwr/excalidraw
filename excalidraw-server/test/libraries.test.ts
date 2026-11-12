/**
 * Libraries on the server (L1, L2): personal, per team collection, per
 * workspace; encrypted at rest; who may use and maintain them.
 */
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

const item = (id: string, text = "Server") => ({
  id,
  status: "published",
  created: 1,
  elements: [
    {
      type: "rectangle",
      id: `${id}-r`,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      label: text,
    },
  ],
});

describeWithDb("libraries", () => {
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
    return { app, id: me.id as string };
  };

  it("keeps the personal library with the account, encrypted", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const other = await person(carol);
    const empty = (await owner.app("GET", "/api/libraries/personal")).json();
    expect(empty.libraryItems).toEqual([]);
    expect(empty.library).toMatchObject({ kind: "personal", canEdit: true });

    const saved = await owner.app("PUT", "/api/libraries/personal", {
      libraryItems: [item("a", "Firewall")],
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await owner.app("GET", "/api/libraries/personal")).json().libraryItems,
    ).toEqual([item("a", "Firewall")]);
    // stored encrypted
    const row = await env.built.ctx.db
      .selectFrom("libraries")
      .selectAll()
      .where("owner_id", "=", owner.id)
      .executeTakeFirstOrThrow();
    expect(row.content!.toString("utf8")).not.toContain("Firewall");
    expect(row.items).toBe(1);

    // nobody else reaches it
    const id = empty.library.id;
    expect((await other.app("GET", `/api/libraries/${id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await other.app("PUT", `/api/libraries/${id}`, { libraryItems: [] }))
        .statusCode,
    ).toBe(404);
    expect(
      (await owner.app("DELETE", "/api/libraries/personal")).statusCode,
    ).toBe(400);
    for (const bad of [
      { libraryItems: "nein" },
      { libraryItems: [{ id: 1, elements: [] }] },
      { libraryItems: [{ id: "x", elements: "nein" }] },
    ]) {
      expect(
        (await owner.app("PUT", "/api/libraries/personal", bad)).statusCode,
      ).toBe(400);
    }
    // optimistic concurrency when asked for
    expect(
      (
        await owner.app("PUT", "/api/libraries/personal", {
          libraryItems: [],
          expectedRevision: 0,
        })
      ).statusCode,
    ).toBe(409);
  });

  it("shares team and company libraries with who may see them", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const lead = await person(bob);
    const colleague = await person(carol);
    const outsider = await person(dave);

    // a team collection for /IT, managed by bob
    const team = (
      await lead.app("POST", "/api/collections", { name: "Netzwerk" })
    ).json();
    await lead.app("PUT", `/api/collections/${team.id}/grants`, {
      grants: [
        { type: "user", principal: lead.id, role: "manager" },
        { type: "group", principal: "/IT", role: "viewer" },
      ],
    });
    const created = await lead.app("POST", "/api/libraries", {
      name: "Netzwerksymbole",
      collectionId: team.id,
    });
    expect(created.statusCode).toBe(201);
    const teamLibrary = created.json().library;
    expect(teamLibrary).toMatchObject({
      kind: "collection",
      canEdit: true,
      scope: { id: team.id, name: "Netzwerk" },
    });
    await lead.app("PUT", `/api/libraries/${teamLibrary.id}`, {
      libraryItems: [item("router", "Router")],
    });

    // viewers of the collection use it, but do not change it
    const seen = (await colleague.app("GET", "/api/libraries")).json();
    expect(
      seen.libraries.map((library: { name: string; canEdit: boolean }) => [
        library.name,
        library.canEdit,
      ]),
    ).toEqual([
      ["Meine Bibliothek", true],
      ["Netzwerksymbole", false],
    ]);
    expect(
      (await colleague.app("GET", `/api/libraries/${teamLibrary.id}`)).json()
        .libraryItems,
    ).toHaveLength(1);
    expect(
      (
        await colleague.app("PUT", `/api/libraries/${teamLibrary.id}`, {
          libraryItems: [],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await colleague.app("POST", "/api/libraries", {
          name: "Meins",
          collectionId: team.id,
        })
      ).statusCode,
    ).toBe(403);
    // others do not see it
    expect(
      (await outsider.app("GET", `/api/libraries/${teamLibrary.id}`))
        .statusCode,
    ).toBe(404);

    // a company library for the default workspace, kept by the admins
    const workspace = (await admin.app("GET", "/api/workspace")).json()
      .workspace;
    const company = await admin.app("POST", "/api/libraries", {
      name: "Firmen-Icons",
      workspaceId: workspace.id,
    });
    expect(company.statusCode).toBe(201);
    expect(
      (
        await lead.app("POST", "/api/libraries", {
          name: "Auch",
          workspaceId: workspace.id,
        })
      ).statusCode,
    ).toBe(403);
    const forOutsider = (await outsider.app("GET", "/api/libraries")).json();
    expect(
      forOutsider.libraries.map((library: { name: string }) => library.name),
    ).toEqual(["Meine Bibliothek", "Firmen-Icons"]);
    expect(forOutsider.canCreate).toEqual({ collections: [], workspaces: [] });

    // rename and delete: maintainers only, recorded in the audit log
    const id = company.json().library.id;
    expect(
      (await lead.app("PATCH", `/api/libraries/${id}`, { name: "x" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await admin.app("PATCH", `/api/libraries/${id}`, { name: "Logos" })
      ).json().library.name,
    ).toBe("Logos");
    expect((await admin.app("DELETE", `/api/libraries/${id}`)).statusCode).toBe(
      204,
    );
    await expect
      .poll(async () =>
        (
          await env.built.ctx.db
            .selectFrom("events")
            .select("data")
            .where("type", "=", "library.changed")
            .orderBy("id")
            .execute()
        ).map((event) => (event.data as { change: string }).change),
      )
      .toEqual(["created", "items", "created", "renamed", "deleted"]);
  });
});
