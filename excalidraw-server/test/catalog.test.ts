/**
 * The company's library catalog (L3): publish, browse, add with one click.
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

const item = (id: string, type: string) => ({
  id,
  status: "published",
  created: 1,
  name: id,
  elements: [
    {
      id: `${id}-shape`,
      type,
      x: 0,
      y: 0,
      width: 120,
      height: 80,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      groupIds: [],
      boundElements: null,
      angle: 0,
    },
  ],
});

describeWithDb("library catalog", () => {
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
    return { app };
  };

  it("publishes libraries for the company and adds them with one click", async () => {
    env = await createTestEnv();
    const author = await person(bob);
    const colleague = await person(carol);
    const admin = await person(alice);

    const published = await author.app("POST", "/api/library-catalog", {
      name: "Netzwerk",
      description: "Router, Switches und Firewalls",
      libraryItems: [item("router", "rectangle"), item("switch", "ellipse")],
    });
    expect(published.statusCode).toBe(201);
    const entry = published.json().entry;
    expect(entry).toMatchObject({
      name: "Netzwerk",
      items: 2,
      author: { name: "Bob Beispiel" },
      canEdit: true,
    });
    expect(entry.preview).toMatch(/^\/api\/library-catalog\/[\w-]+\/preview/);

    // everyone finds it
    const listed = (
      await colleague.app("GET", "/api/library-catalog?q=switch")
    ).json().entries;
    expect(listed).toEqual([
      expect.objectContaining({ id: entry.id, canEdit: false }),
    ]);
    expect(
      (await colleague.app("GET", "/api/library-catalog?q=Drucker")).json()
        .entries,
    ).toEqual([]);

    // a preview drawn on the server, never an uploaded SVG
    const preview = await colleague.app("GET", entry.preview);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(preview.body).toMatch(/^<svg /);

    // as a file, as the editor's #addLibrary link loads it
    const file = await colleague.app(
      "GET",
      `/api/library-catalog/${entry.id}/download`,
    );
    expect(file.json()).toMatchObject({ type: "excalidrawlib", version: 2 });
    expect(file.json().libraryItems).toHaveLength(2);

    // one click: into my own library, without doubles
    expect(
      (
        await colleague.app("POST", `/api/library-catalog/${entry.id}/add`, {})
      ).json().added,
    ).toBe(2);
    expect(
      (
        await colleague.app("POST", `/api/library-catalog/${entry.id}/add`, {})
      ).json().added,
    ).toBe(0);
    const own = (await colleague.app("GET", "/api/libraries/personal")).json();
    expect(
      own.libraryItems.map((libraryItem: { id: string }) => libraryItem.id),
    ).toEqual(["router", "switch"]);
    expect(
      (await author.app("GET", "/api/library-catalog")).json().entries[0]
        .downloads,
    ).toBe(3);

    // only the author and app admins change or remove it
    expect(
      (
        await colleague.app("PATCH", `/api/library-catalog/${entry.id}`, {
          name: "Meins",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await colleague.app("DELETE", `/api/library-catalog/${entry.id}`))
        .statusCode,
    ).toBe(403);
    const renamed = await author.app(
      "PATCH",
      `/api/library-catalog/${entry.id}`,
      { name: "Netzwerk-Symbole", libraryItems: [item("router", "rectangle")] },
    );
    expect(renamed.json().entry).toMatchObject({
      name: "Netzwerk-Symbole",
      items: 1,
    });
    expect(
      (await admin.app("DELETE", `/api/library-catalog/${entry.id}`))
        .statusCode,
    ).toBe(204);

    // publishing a team library needs its editors' rights
    const team = (
      await author.app("POST", "/api/collections", { name: "Architektur" })
    ).json();
    await author.app("PUT", `/api/collections/${team.id}/grants`, {
      grants: [
        {
          type: "user",
          principal: (await author.app("GET", "/api/auth/me")).json().user.id,
          role: "manager",
        },
        { type: "group", principal: "/IT", role: "viewer" },
      ],
    });
    const library = (
      await author.app("POST", "/api/libraries", {
        name: "Architektur-Symbole",
        collectionId: team.id,
      })
    ).json().library;
    await author.app("PUT", `/api/libraries/${library.id}`, {
      libraryItems: [item("server", "rectangle")],
    });
    expect(
      (
        await colleague.app("POST", "/api/library-catalog", {
          name: "Kopie",
          libraryId: library.id,
        })
      ).statusCode,
    ).toBe(403);
    const fromTeam = await author.app("POST", "/api/library-catalog", {
      name: "Architektur",
      libraryId: library.id,
    });
    expect(fromTeam.json().entry.items).toBe(1);

    for (const bad of [
      { name: "", libraryItems: [item("a", "rectangle")] },
      { name: "Leer", libraryItems: [] },
      { name: "Kaputt", libraryItems: [{ id: 1 }] },
      {
        name: "Lang",
        description: "x".repeat(1001),
        libraryItems: [item("a", "rectangle")],
      },
    ]) {
      expect(
        (await author.app("POST", "/api/library-catalog", bad)).statusCode,
      ).toBe(400);
    }

    const events = await env.built.ctx.db
      .selectFrom("events")
      .select("type")
      .where("type", "like", "library_catalog.%")
      .execute();
    expect(events.map((event) => event.type).sort()).toEqual([
      "library_catalog.published",
      "library_catalog.published",
      "library_catalog.removed",
      "library_catalog.updated",
    ]);
  });
});
