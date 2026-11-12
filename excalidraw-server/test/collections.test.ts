/**
 * Collections inside collections (W4): Abteilung › Projekt › Thema, with
 * access flowing down the tree.
 */
import { unzipSync } from "fflate";
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
const erin: FakeUser = {
  sub: "erin",
  name: "Erin Extern",
  email: "erin@example.test",
  groups: ["/Einkauf"],
};

interface CollectionItem {
  id: string;
  name: string;
  parentId: string | null;
  role: string;
}

describeWithDb("nested collections", () => {
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
    const collections = async () =>
      (
        (await app("GET", "/api/workspace")).json()
          .collections as (CollectionItem & {
          kind: string;
        })[]
      )
        .filter((item) => item.kind === "team")
        .map(({ name, parentId, role }) => ({ name, parentId, role }));
    return { app, id: me.id as string, collections };
  };

  it("nests collections and lets access flow down the tree", async () => {
    env = await createTestEnv();
    const lead = await person(bob);
    const member = await person(carol);
    const guest = await person(erin);

    const create = async (name: string, parentId?: string) => {
      const response = await lead.app("POST", "/api/collections", {
        name,
        ...(parentId ? { parentId } : {}),
      });
      expect(response.statusCode).toBe(201);
      return response.json() as CollectionItem;
    };
    const department = await create("Abteilung");
    const project = await create("Projekt", department.id);
    expect(project.parentId).toBe(department.id);
    await lead.app("PUT", `/api/collections/${department.id}/grants`, {
      grants: [
        { type: "user", principal: lead.id, role: "manager" },
        { type: "group", principal: "/IT", role: "editor" },
      ],
    });
    const scene = (
      await lead.app("POST", "/api/scenes", {
        name: "Plan",
        collectionId: project.id,
      })
    ).json().scene;

    // the group sees both, the inner one through the outer one
    expect(await member.collections()).toEqual([
      { name: "Abteilung", parentId: null, role: "editor" },
      { name: "Projekt", parentId: department.id, role: "editor" },
    ]);
    expect(
      (await member.app("GET", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(200);
    expect(await guest.collections()).toEqual([]);
    expect((await guest.app("GET", `/api/scenes/${scene.id}`)).statusCode).toBe(
      404,
    );

    // a grant on the inner one only: no trace of the outer one
    await lead.app("PUT", `/api/collections/${project.id}/grants`, {
      grants: [{ type: "user", principal: guest.id, role: "viewer" }],
    });
    expect(await guest.collections()).toEqual([
      { name: "Projekt", parentId: null, role: "viewer" },
    ]);
    const forGuest = (
      await guest.app("GET", `/api/collections/${project.id}/grants`)
    ).json();
    expect(forGuest.inherited).toHaveLength(1);
    expect(forGuest.inherited[0].collection).toBeNull();
    const forLead = (
      await lead.app("GET", `/api/collections/${project.id}/grants`)
    ).json();
    expect(forLead.inherited[0].collection.name).toBe("Abteilung");
    expect(
      forLead.inherited[0].grants.map(
        (grant: { principal: string }) => grant.principal,
      ),
    ).toContain("/IT");

    // editors of the outer one may add inner ones; viewers may not
    const topic = await member.app("POST", "/api/collections", {
      name: "Thema",
      parentId: project.id,
    });
    expect(topic.statusCode).toBe(201);
    expect(
      (
        await guest.app("POST", "/api/collections", {
          name: "Nicht erlaubt",
          parentId: project.id,
        })
      ).statusCode,
    ).toBe(403);

    // at most five levels
    let parent = topic.json().id as string;
    for (const name of ["Ebene 4", "Ebene 5"]) {
      parent = (await create(name, parent)).id;
    }
    const tooDeep = await lead.app("POST", "/api/collections", {
      name: "Ebene 6",
      parentId: parent,
    });
    expect(tooDeep.statusCode).toBe(400);
    expect(tooDeep.json().error).toBe("too_deep");

    // moving: not into itself, not too deep, otherwise anywhere editable
    const other = await create("Andere");
    const otherInner = await create("Andere innen", other.id);
    expect(
      (
        await lead.app("PATCH", `/api/collections/${department.id}`, {
          parentId: project.id,
        })
      ).json().error,
    ).toBe("invalid_parent");
    // Andere › Andere innen › Projekt › Thema › Ebene 4 › Ebene 5: six
    expect(
      (
        await lead.app("PATCH", `/api/collections/${project.id}`, {
          parentId: otherInner.id,
        })
      ).json().error,
    ).toBe("too_deep");
    const moved = await lead.app(
      "PATCH",
      `/api/collections/${topic.json().id}`,
      { parentId: department.id, name: "Thema A" },
    );
    expect(moved.json()).toMatchObject({
      name: "Thema A",
      parentId: department.id,
    });

    // only empty collections go
    const notEmpty = await lead.app(
      "DELETE",
      `/api/collections/${department.id}`,
    );
    expect(notEmpty.statusCode).toBe(409);
    expect(notEmpty.json().message).toMatch(/Unterordner/);

    // the export of the outer one brings the inner ones, as folders
    const zip = await lead.app(
      "GET",
      `/api/export?collection=${department.id}`,
    );
    expect(zip.statusCode).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(zip.rawPayload)))).toContain(
      "Abteilung/Projekt/Plan.excalidraw",
    );

    // editors through the outer one restore from the trash, too
    expect(
      (await lead.app("DELETE", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(204);
    const trash = (await member.app("GET", "/api/scenes?view=trash")).json()
      .scenes;
    expect(trash.map((item: { id: string }) => item.id)).toContain(scene.id);
    expect(
      (await member.app("POST", `/api/scenes/${scene.id}/restore`)).statusCode,
    ).toBe(200);
  });

  it("gives nobody more rights through a subfolder than the folder above", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const editor = await person(bob);
    const guest = await person(erin);
    const space = (
      await admin.app("POST", "/api/admin/workspaces", { name: "Vertrieb" })
    ).json().workspace;
    await admin.app("PUT", `/api/admin/workspaces/${space.id}/members`, {
      members: [
        { type: "user", principal: admin.id, role: "admin" },
        { type: "user", principal: editor.id, role: "member" },
      ],
    });
    await admin.app("PATCH", `/api/admin/workspaces/${space.id}`, {
      policies: { collectionCreation: "admins", directSharing: false },
    });
    const department = (
      await admin.app("POST", "/api/collections", {
        name: "Abteilung",
        workspaceId: space.id,
      })
    ).json();
    await admin.app("PUT", `/api/collections/${department.id}/grants`, {
      grants: [
        { type: "user", principal: admin.id, role: "manager" },
        { type: "user", principal: editor.id, role: "editor" },
        // a guest: no member of the workspace
        { type: "user", principal: guest.id, role: "editor" },
      ],
    });

    // an editor may organize the folder, and stays an editor in there
    const inner = await editor.app("POST", "/api/collections", {
      name: "Entwürfe",
      parentId: department.id,
    });
    expect(inner.statusCode).toBe(201);
    expect(inner.json().role).toBe("editor");
    const grants = (
      await editor.app("GET", `/api/collections/${inner.json().id}/grants`)
    ).json();
    expect(grants.grants).toEqual([]);
    expect(grants.canManage).toBe(false);
    // so no sharing with outsiders through it, no renaming, no moving
    expect(
      (
        await editor.app("PUT", `/api/collections/${inner.json().id}/grants`, {
          grants: [{ type: "user", principal: guest.id, role: "editor" }],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await editor.app("PATCH", `/api/collections/${inner.json().id}`, {
          parentId: null,
        })
      ).statusCode,
    ).toBe(403);
    // the managers above manage it
    expect(
      (
        await admin.app("GET", `/api/collections/${inner.json().id}/grants`)
      ).json().canManage,
    ).toBe(true);

    // guests do not build folders in a workspace that is not theirs
    expect(
      (
        await guest.app("POST", "/api/collections", {
          name: "Gast-Ordner",
          parentId: department.id,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("keeps the tree a tree when changes come at the same moment", async () => {
    env = await createTestEnv();
    const lead = await person(bob);
    const create = async (name: string, parentId?: string) =>
      (
        await lead.app("POST", "/api/collections", {
          name,
          ...(parentId ? { parentId } : {}),
        })
      ).json() as CollectionItem;

    // two moves at once: A into B, B into A
    for (let round = 0; round < 5; round++) {
      const a = await create(`A${round}`);
      const b = await create(`B${round}`);
      const [first, second] = await Promise.all([
        lead.app("PATCH", `/api/collections/${a.id}`, { parentId: b.id }),
        lead.app("PATCH", `/api/collections/${b.id}`, { parentId: a.id }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
      const tree = await lead.collections();
      expect(
        tree.filter((item) => item.name.endsWith(String(round))),
      ).toHaveLength(2);
      expect(
        (await lead.app("GET", `/api/export?collection=${a.id}`)).statusCode,
      ).toBe(200);
    }

    // a folder deleted while a subfolder is created in it
    for (let round = 0; round < 5; round++) {
      const parent = await create(`Eltern${round}`);
      const [removed, added] = await Promise.all([
        lead.app("DELETE", `/api/collections/${parent.id}`),
        lead.app("POST", "/api/collections", {
          name: `Kind${round}`,
          parentId: parent.id,
        }),
      ]);
      // never both: no subfolder inside a deleted folder
      expect(removed.statusCode === 204 && added.statusCode === 201).toBe(
        false,
      );
    }

    // back at the top, a folder keeps someone who manages it
    const outer = await create("Außen");
    const loose = await create("Lose", outer.id);
    await lead.app("PUT", `/api/collections/${loose.id}/grants`, {
      grants: [],
    });
    const back = await lead.app("PATCH", `/api/collections/${loose.id}`, {
      parentId: null,
    });
    expect(back.statusCode).toBe(200);
    const own = (
      await lead.app("GET", `/api/collections/${loose.id}/grants`)
    ).json();
    expect(own.canManage).toBe(true);
    expect(own.grants).toEqual([
      expect.objectContaining({ principal: lead.id, role: "manager" }),
    ]);
  });
});
