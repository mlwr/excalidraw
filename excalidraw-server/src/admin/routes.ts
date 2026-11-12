/**
 * Administration:
 * - workspaces with members and policies (W10, T5): app admins create and
 *   delete them, workspace admins run theirs
 * - people (S3): disable, revoke tokens, remove for data protection reasons
 * - audit log (S2), app admins only, also as CSV
 * - branding (B8) and figures for the operators (B7)
 */
import { sql } from "kysely";

import { HttpError, sendError } from "../util/http.js";
import { hasControlChars, queryParam, searchText } from "../util/validate.js";
import { actorOf } from "../workspace/access.js";
import {
  parsePolicies,
  policiesOf,
  workspaceAccess,
} from "../workspace/workspaces.js";

import type { AppContext } from "../context.js";
import type { PrincipalType, Workspace } from "../db/schema.js";
import type { Actor } from "../workspace/access.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/svg+xml", "image/webp"]);
const ERASED_NAME = "Gelöschte Person";

export interface Branding {
  name: string;
  primaryColor: string | null;
  links: { label: string; url: string }[];
  /** version of the uploaded logo, null = default logo */
  logo: number | null;
}

const DEFAULT_BRANDING: Branding = {
  name: "Excalidraw",
  primaryColor: null,
  links: [],
  logo: null,
};

const forbidden = () =>
  new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");

const cleanText = (value: unknown, max: number, what: string) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    hasControlChars(value)
  ) {
    throw new HttpError(
      400,
      "invalid_input",
      `${what}: Text mit höchstens ${max} Zeichen.`,
    );
  }
  return value.replace(/\s+/g, " ").trim();
};

export const registerAdminRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config } = ctx;
  const options = { preHandler: requireAuth };
  const actor = (request: FastifyRequest): Actor => actorOf(request.auth!.user);
  const body = (request: FastifyRequest) =>
    (request.body && typeof request.body === "object"
      ? request.body
      : {}) as Record<string, unknown>;
  const requireAppAdmin = (request: FastifyRequest) => {
    if (!request.auth!.user.is_admin) {
      throw forbidden();
    }
  };
  const policies = (workspace: Pick<Workspace, "settings">) =>
    policiesOf(workspace, { trashRetentionDays: config.retention.trashDays });

  /** a workspace the actor administers */
  const administered = async (request: FastifyRequest, id: string) => {
    if (!UUID_RE.test(id)) {
      throw new HttpError(404, "not_found", "Workspace nicht gefunden.");
    }
    const workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!workspace) {
      throw new HttpError(404, "not_found", "Workspace nicht gefunden.");
    }
    if ((await workspaceAccess(db, actor(request), workspace)) !== "admin") {
      throw forbidden();
    }
    return workspace;
  };

  const describeWorkspace = async (workspace: Workspace) => {
    const counts = await db
      .selectFrom("scenes")
      .select(sql<number>`count(*)::int`.as("scenes"))
      .where("workspace_id", "=", workspace.id)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const members = await db
      .selectFrom("workspace_members")
      .select(sql<number>`count(*)::int`.as("members"))
      .where("workspace_id", "=", workspace.id)
      .executeTakeFirstOrThrow();
    return {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      openToAll: workspace.open_to_all,
      isDefault: workspace.slug === "default",
      policies: policies(workspace),
      scenes: counts.scenes,
      members: members.members,
      createdAt: workspace.created_at,
    };
  };

  // --- workspaces -------------------------------------------------------------------

  app.get("/api/admin/workspaces", options, async (request) => {
    const current = actor(request);
    const all = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("open_to_all", "desc")
      .orderBy("name")
      .execute();
    const result = [];
    for (const workspace of all) {
      if ((await workspaceAccess(db, current, workspace)) === "admin") {
        result.push(await describeWorkspace(workspace));
      }
    }
    return {
      workspaces: result,
      isAppAdmin: request.auth!.user.is_admin,
    };
  });

  app.post("/api/admin/workspaces", options, async (request, reply) => {
    requireAppAdmin(request);
    const input = body(request);
    const name = cleanText(input.name, 100, "Name");
    const slug =
      typeof input.slug === "string" && input.slug
        ? input.slug
        : name
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "workspace";
    if (!SLUG_RE.test(slug) || slug === "default" || UUID_RE.test(slug)) {
      throw new HttpError(
        400,
        "invalid_slug",
        "Kurzname: a-z, 0-9 und Bindestriche.",
      );
    }
    const created = await db
      .insertInto("workspaces")
      .values({
        name,
        slug,
        open_to_all: input.openToAll === true,
        created_by: request.auth!.user.id,
      })
      .onConflict((oc) => oc.column("slug").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!created) {
      throw new HttpError(409, "slug_taken", "Diesen Kurznamen gibt es schon.");
    }
    ctx.events.record({
      type: "workspace.created",
      actor: request.auth!.user,
      request,
      workspaceId: created.id,
      data: { name, slug },
    });
    return reply
      .code(201)
      .send({ workspace: await describeWorkspace(created) });
  });

  app.patch<{ Params: { workspaceId: string } }>(
    "/api/admin/workspaces/:workspaceId",
    options,
    async (request) => {
      const workspace = await administered(request, request.params.workspaceId);
      const input = body(request);
      const changes: Record<string, unknown> = {};
      if (input.name !== undefined) {
        changes.name = cleanText(input.name, 100, "Name");
      }
      if (input.openToAll !== undefined) {
        // who belongs to a workspace is the app admins' decision
        requireAppAdmin(request);
        if (typeof input.openToAll !== "boolean") {
          throw new HttpError(
            400,
            "invalid_input",
            "openToAll: true oder false.",
          );
        }
        changes.open_to_all = input.openToAll;
      }
      const before = policies(workspace);
      let after = before;
      if (input.policies !== undefined) {
        after = parsePolicies(input.policies, before);
        changes.settings = { ...workspace.settings, policies: after };
      }
      if (!Object.keys(changes).length) {
        throw new HttpError(400, "nothing_to_change", "Nichts zu ändern.");
      }
      await db
        .updateTable("workspaces")
        .set(changes)
        .where("id", "=", workspace.id)
        .execute();

      // switched off: what exists of it stops working now
      const affected: string[] = [];
      if (before.readLinks && !after.readLinks) {
        const scenes = await db
          .updateTable("scenes")
          .set({ read_link_token: null })
          .where("workspace_id", "=", workspace.id)
          .where("read_link_token", "is not", null)
          .returning("id")
          .execute();
        affected.push(...scenes.map((scene) => scene.id));
        if (scenes.length) {
          await db
            .deleteFrom("scene_link_viewers")
            .where(
              "scene_id",
              "in",
              scenes.map((scene) => scene.id),
            )
            .execute();
        }
      }
      if (before.directSharing && !after.directSharing) {
        const removed = await sql<{ scene_id: string }>`
          delete from scene_grants g using scenes s
          where g.scene_id = s.id and s.workspace_id = ${workspace.id}
          returning g.scene_id
        `.execute(db);
        affected.push(...removed.rows.map((row) => row.scene_id));
      }
      if (affected.length) {
        await ctx.realtime
          .recheckScenes([...new Set(affected)])
          .catch(() => {});
      }
      ctx.events.record({
        type: "workspace.updated",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        data: {
          ...(changes.name ? { name: changes.name } : {}),
          ...(changes.open_to_all !== undefined
            ? { openToAll: changes.open_to_all }
            : {}),
          ...(input.policies !== undefined ? { policies: after } : {}),
        },
      });
      const updated = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspace.id)
        .executeTakeFirstOrThrow();
      return { workspace: await describeWorkspace(updated) };
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/api/admin/workspaces/:workspaceId",
    options,
    async (request, reply) => {
      requireAppAdmin(request);
      const workspace = await administered(request, request.params.workspaceId);
      if (workspace.slug === "default") {
        throw new HttpError(
          400,
          "default_workspace",
          "Der allgemeine Workspace bleibt.",
        );
      }
      const scenes = await db
        .selectFrom("scenes")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("workspace_id", "=", workspace.id)
        .executeTakeFirstOrThrow();
      if (scenes.count > 0) {
        throw new HttpError(
          409,
          "workspace_not_empty",
          "Der Workspace enthält noch Szenen (auch im Papierkorb).",
        );
      }
      await db
        .updateTable("workspaces")
        .set({ deleted_at: sql`now()` })
        .where("id", "=", workspace.id)
        .execute();
      ctx.events.record({
        type: "workspace.deleted",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        data: { name: workspace.name },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/admin/workspaces/:workspaceId/members",
    options,
    async (request) => {
      const workspace = await administered(request, request.params.workspaceId);
      const rows = await db
        .selectFrom("workspace_members")
        .select(["principal_type", "principal", "role"])
        .where("workspace_id", "=", workspace.id)
        .orderBy("role", "asc")
        .execute();
      const userIds = rows
        .filter((row) => row.principal_type === "user")
        .map((row) => row.principal);
      const names = new Map(
        userIds.length
          ? (
              await db
                .selectFrom("users")
                .select(["id", "name"])
                .where("id", "in", userIds)
                .execute()
            ).map((row) => [row.id, row.name])
          : [],
      );
      return {
        members: rows.map((row) => ({
          type: row.principal_type,
          principal: row.principal,
          role: row.role,
          label:
            row.principal_type === "user"
              ? names.get(row.principal) || "Unbekannte Person"
              : row.principal,
        })),
      };
    },
  );

  app.put<{ Params: { workspaceId: string } }>(
    "/api/admin/workspaces/:workspaceId/members",
    options,
    async (request) => {
      const workspace = await administered(request, request.params.workspaceId);
      const input = body(request).members;
      if (!Array.isArray(input) || input.length > 500) {
        throw new HttpError(400, "invalid_members", "members: eine Liste.");
      }
      const members = new Map<
        string,
        { type: PrincipalType; principal: string; role: "member" | "admin" }
      >();
      for (const item of input as Record<string, unknown>[]) {
        const type = item?.type;
        const role = item?.role;
        let principal =
          typeof item?.principal === "string" ? item.principal.trim() : "";
        if (
          (type !== "user" && type !== "group") ||
          (role !== "member" && role !== "admin") ||
          !principal ||
          principal.length > 500 ||
          hasControlChars(principal) ||
          (type === "user" && !UUID_RE.test(principal))
        ) {
          throw new HttpError(400, "invalid_members", "Ungültiger Eintrag.");
        }
        if (type === "user") {
          principal = principal.toLowerCase();
        }
        const key = `${type}:${principal}`;
        const existing = members.get(key);
        if (!existing || (existing.role === "member" && role === "admin")) {
          members.set(key, { type, principal, role });
        }
      }
      const userIds = [...members.values()]
        .filter((member) => member.type === "user")
        .map((member) => member.principal);
      if (userIds.length) {
        const found = await db
          .selectFrom("users")
          .select("id")
          .where("id", "in", userIds)
          .execute();
        if (found.length !== userIds.length) {
          throw new HttpError(400, "unknown_user", "Unbekannte Person.");
        }
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("workspace_members")
          .where("workspace_id", "=", workspace.id)
          .execute();
        if (members.size) {
          await trx
            .insertInto("workspace_members")
            .values(
              [...members.values()].map((member) => ({
                workspace_id: workspace.id,
                principal_type: member.type,
                principal: member.principal,
                role: member.role,
                created_by: request.auth!.user.id,
              })),
            )
            .execute();
        }
      });
      ctx.events.record({
        type: "workspace.members",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        data: {
          members: [...members.values()].map(
            (member) => `${member.type}:${member.principal}:${member.role}`,
          ),
        },
      });
      return { ok: true };
    },
  );

  // --- people (S3) -------------------------------------------------------------------

  const userById = async (id: string) => {
    if (!UUID_RE.test(id)) {
      throw new HttpError(404, "not_found", "Person nicht gefunden.");
    }
    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!user) {
      throw new HttpError(404, "not_found", "Person nicht gefunden.");
    }
    return user;
  };

  app.get("/api/admin/users", options, async (request) => {
    requireAppAdmin(request);
    const query = request.query as Record<string, unknown>;
    const q = searchText(query.q);
    const offset = Math.max(
      0,
      Math.min(1_000_000, Number(queryParam(query.offset)) || 0),
    );
    let users = db.selectFrom("users").selectAll();
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      users = users.where((eb) =>
        eb.or([
          eb("name", "ilike", pattern),
          eb("email", "ilike", pattern),
          eb("username", "ilike", pattern),
        ]),
      );
    }
    const rows = await users.orderBy("name").limit(50).offset(offset).execute();
    const tokens = rows.length
      ? await db
          .selectFrom("api_tokens")
          .select(["user_id", sql<number>`count(*)::int`.as("count")])
          .where(
            "user_id",
            "in",
            rows.map((row) => row.id),
          )
          .where("revoked_at", "is", null)
          .where("expires_at", ">", sql<Date>`now()`)
          .groupBy("user_id")
          .execute()
      : [];
    const tokenCount = new Map(tokens.map((row) => [row.user_id, row.count]));
    return {
      users: rows.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        groups: user.groups,
        isAdmin: user.is_admin,
        lastLoginAt: user.last_login_at,
        disabledAt: user.disabled_at,
        erasedAt: user.erased_at,
        activeTokens: tokenCount.get(user.id) || 0,
      })),
      next: rows.length === 50 ? offset + 50 : null,
    };
  });

  /** no more sessions and tokens for a person */
  const cutOff = async (userId: string) => {
    const sessions = await db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .returning("id")
      .execute();
    ctx.realtime.disconnectSessions(sessions.map((session) => session.id));
    await db
      .updateTable("api_tokens")
      .set({ revoked_at: sql`now()` })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  };

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/disable",
    options,
    async (request) => {
      requireAppAdmin(request);
      const user = await userById(request.params.userId);
      if (user.id === request.auth!.user.id) {
        throw new HttpError(
          400,
          "self",
          "Das eigene Konto lässt sich nicht sperren.",
        );
      }
      await db
        .updateTable("users")
        .set({ disabled_at: sql`now()` })
        .where("id", "=", user.id)
        .execute();
      await cutOff(user.id);
      ctx.events.record({
        type: "admin.user_disabled",
        actor: request.auth!.user,
        request,
        target: user.id,
        data: { name: user.name },
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/enable",
    options,
    async (request) => {
      requireAppAdmin(request);
      const user = await userById(request.params.userId);
      if (user.erased_at) {
        throw new HttpError(
          400,
          "erased",
          "Gelöschte Personen bleiben gelöscht.",
        );
      }
      await db
        .updateTable("users")
        .set({ disabled_at: null })
        .where("id", "=", user.id)
        .execute();
      ctx.events.record({
        type: "admin.user_enabled",
        actor: request.auth!.user,
        request,
        target: user.id,
        data: { name: user.name },
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/revoke-tokens",
    options,
    async (request) => {
      requireAppAdmin(request);
      const user = await userById(request.params.userId);
      const revoked = await db
        .updateTable("api_tokens")
        .set({ revoked_at: sql`now()` })
        .where("user_id", "=", user.id)
        .where("revoked_at", "is", null)
        .returning("id")
        .execute();
      ctx.events.record({
        type: "admin.tokens_revoked",
        actor: request.auth!.user,
        request,
        target: user.id,
        data: { name: user.name, tokens: revoked.length },
      });
      return { revoked: revoked.length };
    },
  );

  /**
   * Remove a person (data protection, e.g. after leaving): their personal
   * scenes go to a successor or into the trash, their grants, sessions,
   * tokens and traces of use are deleted, their name is replaced in the
   * app and in the audit log.
   */
  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/erase",
    options,
    async (request) => {
      requireAppAdmin(request);
      const user = await userById(request.params.userId);
      if (user.id === request.auth!.user.id) {
        throw new HttpError(
          400,
          "self",
          "Das eigene Konto lässt sich nicht entfernen.",
        );
      }
      if (user.erased_at) {
        throw new HttpError(400, "erased", "Diese Person ist schon entfernt.");
      }
      const successorId = body(request).successorId;
      let successor: { id: string; name: string } | null = null;
      if (successorId !== undefined && successorId !== null) {
        if (typeof successorId !== "string") {
          throw new HttpError(
            400,
            "invalid_input",
            "successorId ist eine Personen-id.",
          );
        }
        const found = await userById(successorId);
        if (found.disabled_at || found.id === user.id) {
          throw new HttpError(
            400,
            "invalid_successor",
            "Nachfolge muss eine aktive andere Person sein.",
          );
        }
        successor = { id: found.id, name: found.name };
      }

      let moved = 0;
      let trashed = 0;
      await db.transaction().execute(async (trx) => {
        const personal = await trx
          .selectFrom("collections")
          .selectAll()
          .where("kind", "=", "personal")
          .where("owner_id", "=", user.id)
          .execute();
        for (const collection of personal) {
          if (successor) {
            await trx
              .insertInto("collections")
              .values({
                workspace_id: collection.workspace_id,
                name: "Meine Szenen",
                kind: "personal",
                owner_id: successor.id,
                created_by: successor.id,
              })
              .onConflict((oc) =>
                oc
                  .columns(["workspace_id", "owner_id"])
                  .where("kind", "=", "personal")
                  .doNothing(),
              )
              .execute();
            const target = await trx
              .selectFrom("collections")
              .select("id")
              .where("kind", "=", "personal")
              .where("owner_id", "=", successor.id)
              .where("workspace_id", "=", collection.workspace_id)
              .executeTakeFirstOrThrow();
            const result = await trx
              .updateTable("scenes")
              .set({ collection_id: target.id })
              .where("collection_id", "=", collection.id)
              .executeTakeFirst();
            moved += Number(result.numUpdatedRows);
          } else {
            const result = await trx
              .updateTable("scenes")
              .set({
                deleted_at: sql`coalesce(deleted_at, now())`,
                deleted_by: request.auth!.user.id,
              })
              .where("collection_id", "=", collection.id)
              .executeTakeFirst();
            trashed += Number(result.numUpdatedRows);
          }
        }
        for (const table of [
          "collection_grants",
          "scene_grants",
          "workspace_members",
        ] as const) {
          await trx
            .deleteFrom(table)
            .where("principal_type", "=", "user")
            .where("principal", "=", user.id)
            .execute();
        }
        await trx
          .deleteFrom("scene_visits")
          .where("user_id", "=", user.id)
          .execute();
        await trx
          .deleteFrom("scene_link_viewers")
          .where("user_id", "=", user.id)
          .execute();
        await trx
          .deleteFrom("api_tokens")
          .where("user_id", "=", user.id)
          .execute();
        await trx
          .updateTable("users")
          .set({
            name: ERASED_NAME,
            email: null,
            username: null,
            roles: [],
            groups: [],
            is_admin: false,
            // a later login of the same Keycloak account starts afresh
            oidc_subject: `erased:${user.id}`,
            disabled_at: sql`now()`,
            erased_at: sql`now()`,
          })
          .where("id", "=", user.id)
          .execute();
        await trx
          .updateTable("events")
          .set({ actor_name: ERASED_NAME, ip: null, user_agent: null })
          .where("actor_id", "=", user.id)
          .execute();
      });
      // sessions last: they would be gone with the person anyway
      const sessions = await db
        .deleteFrom("sessions")
        .where("user_id", "=", user.id)
        .returning("id")
        .execute();
      ctx.realtime.disconnectSessions(sessions.map((session) => session.id));
      ctx.events.record({
        type: "admin.user_erased",
        actor: request.auth!.user,
        request,
        target: user.id,
        data: {
          scenesMoved: moved,
          scenesTrashed: trashed,
          successor: successor?.name ?? null,
        },
      });
      return { moved, trashed };
    },
  );

  // --- audit log (S2) --------------------------------------------------------------

  const auditQuery = (request: FastifyRequest) => {
    const query = request.query as Record<string, unknown>;
    let events = db.selectFrom("events").selectAll();
    const type = queryParam(query.type);
    if (type) {
      if (!/^[a-z_.]{1,40}$/.test(type)) {
        throw new HttpError(400, "invalid_type", "Ungültiger Typ.");
      }
      events = type.endsWith(".")
        ? events.where("type", "like", `${type}%`)
        : events.where("type", "=", type);
    }
    const actorId = queryParam(query.actor);
    if (actorId) {
      if (!UUID_RE.test(actorId)) {
        throw new HttpError(
          400,
          "invalid_actor",
          "actor ist eine Personen-id.",
        );
      }
      events = events.where("actor_id", "=", actorId);
    }
    const sceneId = queryParam(query.scene);
    if (sceneId) {
      events = events.where("scene_id", "=", sceneId.slice(0, 64));
    }
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<"],
    ] as const) {
      const value = queryParam(query[key]);
      if (value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          throw new HttpError(
            400,
            "invalid_date",
            `${key}: Datum im ISO-Format.`,
          );
        }
        events = events.where("at", op, date);
      }
    }
    return events;
  };

  app.get("/api/admin/audit", options, async (request, reply) => {
    requireAppAdmin(request);
    const query = request.query as Record<string, unknown>;
    if (queryParam(query.format) === "csv") {
      const rows = await auditQuery(request)
        .orderBy("id", "desc")
        .limit(100_000)
        .execute();
      const cell = (value: unknown) => {
        const text =
          value === null || value === undefined
            ? ""
            : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
        // no formulas when opened in a spreadsheet
        const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const lines = [
        "id;at;type;actor_id;actor_name;workspace_id;collection_id;scene_id;target;data;ip;user_agent",
        ...rows.map((row) =>
          [
            row.id,
            new Date(row.at).toISOString(),
            row.type,
            row.actor_id,
            row.actor_name,
            row.workspace_id,
            row.collection_id,
            row.scene_id,
            row.target,
            row.data,
            row.ip,
            row.user_agent,
          ]
            .map(cell)
            .join(";"),
        ),
      ];
      ctx.events.record({
        type: "admin.audit_exported",
        actor: request.auth!.user,
        request,
        data: { rows: rows.length },
      });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="audit-${new Date()
            .toISOString()
            .slice(0, 10)}.csv"`,
        )
        .header("cache-control", "no-store")
        .send(`﻿${lines.join("\r\n")}\r\n`);
    }
    let events = auditQuery(request);
    const before = queryParam(query.before);
    if (before) {
      if (!/^\d{1,18}$/.test(before)) {
        throw new HttpError(
          400,
          "invalid_before",
          "before ist eine Ereignis-id.",
        );
      }
      events = events.where("id", "<", before);
    }
    const rows = await events.orderBy("id", "desc").limit(100).execute();
    reply.header("cache-control", "no-store");
    return {
      events: rows,
      next: rows.length === 100 ? rows[rows.length - 1].id : null,
    };
  });

  // --- branding (B8) -----------------------------------------------------------------

  const branding = async (): Promise<Branding> => {
    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "branding")
      .executeTakeFirst();
    return {
      ...DEFAULT_BRANDING,
      ...((row?.value as Partial<Branding>) || {}),
    };
  };

  const saveBranding = async (value: Branding, userId: string) => {
    await db
      .insertInto("settings")
      .values({
        key: "branding",
        value: JSON.stringify(value),
        updated_by: userId,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: JSON.stringify(value),
          updated_by: userId,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  };

  /** public: the app shows it before and after signing in */
  app.get("/api/branding", async (_request, reply) => {
    reply.header("cache-control", "no-cache");
    return branding();
  });

  app.get("/api/branding/logo", async (_request, reply) => {
    const logo = await ctx.blobs.get("branding/logo");
    if (!logo) {
      return sendError(reply, 404, "not_found");
    }
    return reply
      .header("content-type", logo.contentType || "image/png")
      .header("cache-control", "public, max-age=300")
      .send(logo.data);
  });

  app.put("/api/admin/branding", options, async (request) => {
    requireAppAdmin(request);
    const input = body(request);
    const current = await branding();
    const next: Branding = { ...current };
    if (input.name !== undefined) {
      next.name = cleanText(input.name, 60, "Name");
    }
    if (input.primaryColor !== undefined) {
      if (
        input.primaryColor !== null &&
        (typeof input.primaryColor !== "string" ||
          !/^#[0-9a-fA-F]{6}$/.test(input.primaryColor))
      ) {
        throw new HttpError(400, "invalid_color", "Farbe als #RRGGBB.");
      }
      next.primaryColor = input.primaryColor as string | null;
    }
    if (input.links !== undefined) {
      if (!Array.isArray(input.links) || input.links.length > 6) {
        throw new HttpError(400, "invalid_links", "Höchstens 6 Links.");
      }
      next.links = input.links.map((link: Record<string, unknown>) => {
        const url = typeof link?.url === "string" ? link.url.trim() : "";
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        if (
          !parsed ||
          !["https:", "http:"].includes(parsed.protocol) ||
          url.length > 500
        ) {
          throw new HttpError(
            400,
            "invalid_links",
            "Links brauchen eine http(s)-Adresse.",
          );
        }
        return {
          label: cleanText(link?.label, 40, "Bezeichnung"),
          url: parsed.toString(),
        };
      });
    }
    await saveBranding(next, request.auth!.user.id);
    ctx.events.record({
      type: "admin.branding",
      actor: request.auth!.user,
      request,
      data: {
        name: next.name,
        primaryColor: next.primaryColor,
        links: next.links.length,
      },
    });
    return next;
  });

  for (const type of LOGO_TYPES) {
    if (!app.hasContentTypeParser(type)) {
      app.addContentTypeParser(type, { parseAs: "buffer" }, (_r, data, done) =>
        done(null, data),
      );
    }
  }

  app.put(
    "/api/admin/branding/logo",
    { ...options, bodyLimit: MAX_LOGO_BYTES },
    async (request) => {
      requireAppAdmin(request);
      const type = String(request.headers["content-type"] || "").split(";")[0];
      if (
        !LOGO_TYPES.has(type) ||
        !Buffer.isBuffer(request.body) ||
        !request.body.length
      ) {
        throw new HttpError(
          400,
          "invalid_logo",
          "Logo als PNG, SVG oder WebP (höchstens 512 KB).",
        );
      }
      await ctx.blobs.put("branding/logo", request.body, {
        contentType: type,
        createdBy: request.auth!.user.id,
      });
      const next = { ...(await branding()), logo: Date.now() };
      await saveBranding(next, request.auth!.user.id);
      ctx.events.record({
        type: "admin.branding",
        actor: request.auth!.user,
        request,
        data: { logo: "uploaded" },
      });
      return next;
    },
  );

  app.delete("/api/admin/branding/logo", options, async (request) => {
    requireAppAdmin(request);
    await ctx.blobs.deletePrefix("branding/logo");
    const next = { ...(await branding()), logo: null };
    await saveBranding(next, request.auth!.user.id);
    return next;
  });

  // --- figures for the operators (B7) ------------------------------------------------

  app.get("/api/admin/stats", options, async (request) => {
    requireAppAdmin(request);
    const row = await sql<Record<string, string | number>>`
      select
        (select count(*) from users where erased_at is null)::int as users,
        (select count(*) from users where last_login_at > now() - interval '30 days')::int as active_users_30d,
        (select count(*) from workspaces where deleted_at is null)::int as workspaces,
        (select count(*) from collections where deleted_at is null and kind = 'team')::int as team_collections,
        (select count(*) from scenes where deleted_at is null)::int as scenes,
        (select count(*) from scenes where deleted_at is not null)::int as scenes_in_trash,
        (select coalesce(sum(length(ciphertext)), 0) from scenes)::bigint as scene_bytes,
        (select count(*) from scene_versions)::int as versions,
        (select coalesce(sum(size), 0) from scene_versions)::bigint as version_bytes,
        (select count(*) from comment_threads where deleted_at is null)::int as comment_threads,
        (select count(*) from api_tokens where revoked_at is null and expires_at > now())::int as active_tokens,
        (select count(*) from events)::int as events
    `.execute(db);
    const blobs =
      config.storage.driver === "postgres"
        ? await sql<{
            count: number;
            bytes: string;
          }>`select count(*)::int as count, coalesce(sum(size), 0)::bigint as bytes from blobs`.execute(
            db,
          )
        : null;
    return {
      ...row.rows[0],
      blobs: blobs ? blobs.rows[0] : { driver: "s3" },
      retention: config.retention,
      version: process.env.GIT_SHA || null,
    };
  });

  // members of workspaces see who else is in there (for sharing dialogs)
  app.get("/api/workspaces", options, async (request) => {
    const current = actor(request);
    const rows = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("deleted_at", "is", null)
      .execute();
    const result = [];
    for (const workspace of rows) {
      const access = await workspaceAccess(db, current, workspace);
      if (access !== "none") {
        result.push({
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          access,
        });
      }
    }
    return { workspaces: result };
  });
};
