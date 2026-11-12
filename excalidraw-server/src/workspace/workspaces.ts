/**
 * Several workspaces (W10), e.g. one per department or programme. Each has
 * members (people or Keycloak groups, as member or admin) and policies
 * (T5). The default workspace is open to everybody who may use the app.
 *
 * Access to collections and scenes stays grant-based: people outside a
 * workspace see what is shared with them ("guest"). Workspace admins manage
 * every team collection of their workspace; app admins (excalidraw-admin)
 * manage everything.
 */
import { sql } from "kysely";

import { HttpError } from "../util/http.js";

import { grantMatches } from "./access.js";

import type { Database, Workspace } from "../db/schema.js";
import type { Actor } from "./access.js";
import type { Kysely } from "kysely";

export type WorkspaceAccess = "none" | "guest" | "member" | "admin";

const RANK: Record<WorkspaceAccess, number> = {
  none: 0,
  guest: 1,
  member: 2,
  admin: 3,
};

export const atLeastWorkspace = (
  access: WorkspaceAccess,
  minimum: WorkspaceAccess,
) => RANK[access] >= RANK[minimum];

// --- policies (T5) -------------------------------------------------------------

export interface WorkspacePolicies {
  /** read-only links to scenes */
  readLinks: boolean;
  /** sharing single scenes with people and groups */
  directSharing: boolean;
  /** who creates team collections */
  collectionCreation: "members" | "admins";
  /** members may export (admins always may) */
  export: boolean;
  /** days a deleted scene stays in the trash */
  trashRetentionDays: number;
}

export const policiesOf = (
  workspace: Pick<Workspace, "settings">,
  defaults: { trashRetentionDays: number },
): WorkspacePolicies => {
  const stored = (workspace.settings?.policies || {}) as Record<
    string,
    unknown
  >;
  return {
    readLinks: stored.readLinks !== false,
    directSharing: stored.directSharing !== false,
    collectionCreation:
      stored.collectionCreation === "admins" ? "admins" : "members",
    export: stored.export !== false,
    trashRetentionDays:
      typeof stored.trashRetentionDays === "number"
        ? stored.trashRetentionDays
        : defaults.trashRetentionDays,
  };
};

/** checked policies from an admin's input */
export const parsePolicies = (
  input: unknown,
  current: WorkspacePolicies,
): WorkspacePolicies => {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "invalid_policies", "Ungültige Richtlinien.");
  }
  const value = input as Record<string, unknown>;
  const next = { ...current };
  for (const key of ["readLinks", "directSharing", "export"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new HttpError(
          400,
          "invalid_policies",
          `${key}: true oder false.`,
        );
      }
      next[key] = value[key] as boolean;
    }
  }
  if (value.collectionCreation !== undefined) {
    if (
      value.collectionCreation !== "members" &&
      value.collectionCreation !== "admins"
    ) {
      throw new HttpError(
        400,
        "invalid_policies",
        "collectionCreation: members oder admins.",
      );
    }
    next.collectionCreation = value.collectionCreation;
  }
  if (value.trashRetentionDays !== undefined) {
    const days = value.trashRetentionDays;
    if (
      !Number.isInteger(days) ||
      (days as number) < 1 ||
      (days as number) > 3650
    ) {
      throw new HttpError(
        400,
        "invalid_policies",
        "trashRetentionDays: 1 bis 3650 Tage.",
      );
    }
    next.trashRetentionDays = days as number;
  }
  return next;
};

// --- membership ------------------------------------------------------------------

/** the actor's explicit roles per workspace (members, admins) */
const explicitRoles = async (db: Kysely<Database>, actor: Actor) => {
  const rows = await db
    .selectFrom("workspace_members")
    .select(["workspace_id", "role"])
    .where(grantMatches(actor))
    .execute();
  const roles = new Map<string, WorkspaceAccess>();
  for (const row of rows) {
    const role = row.role as WorkspaceAccess;
    const before = roles.get(row.workspace_id) || "none";
    roles.set(row.workspace_id, RANK[role] > RANK[before] ? role : before);
  }
  return roles;
};

/** workspaces in which the actor sees something shared (without membership) */
const guestWorkspaces = async (db: Kysely<Database>, actor: Actor) => {
  const rows = await sql<{ workspace_id: string }>`
    select distinct c.workspace_id
    from collections c
    join collection_grants g on g.collection_id = c.id
    where c.deleted_at is null and ${grantMatches(actor)}
    union
    select distinct s.workspace_id
    from scenes s
    join scene_grants g on g.scene_id = s.id
    where s.deleted_at is null and ${grantMatches(actor)}
  `.execute(db);
  return new Set(rows.rows.map((row) => row.workspace_id));
};

export const workspaceAccess = async (
  db: Kysely<Database>,
  actor: Actor,
  workspace: Workspace,
): Promise<WorkspaceAccess> => {
  if (workspace.deleted_at) {
    return "none";
  }
  if (actor.isAdmin) {
    return "admin";
  }
  const explicit = (await explicitRoles(db, actor)).get(workspace.id) || "none";
  if (explicit !== "none") {
    return explicit;
  }
  if (workspace.open_to_all) {
    return "member";
  }
  return (await guestWorkspaces(db, actor)).has(workspace.id)
    ? "guest"
    : "none";
};

/** whether the actor manages all team collections of the workspace */
export const isWorkspaceAdmin = async (
  db: Kysely<Database>,
  actor: Actor,
  workspaceId: string,
) => {
  if (actor.isAdmin) {
    return true;
  }
  const row = await db
    .selectFrom("workspace_members")
    .select("role")
    .where("workspace_id", "=", workspaceId)
    .where("role", "=", "admin")
    .where(grantMatches(actor))
    .executeTakeFirst();
  return !!row;
};

/** the workspaces the actor can open, default first */
export const listWorkspaces = async (db: Kysely<Database>, actor: Actor) => {
  const all = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("deleted_at", "is", null)
    .orderBy("open_to_all", "desc")
    .orderBy("name")
    .execute();
  const explicit = await explicitRoles(db, actor);
  const guest = await guestWorkspaces(db, actor);
  return all
    .map((workspace) => {
      let access: WorkspaceAccess = explicit.get(workspace.id) || "none";
      if (actor.isAdmin) {
        access = "admin";
      } else if (access === "none" && workspace.open_to_all) {
        access = "member";
      } else if (access === "none" && guest.has(workspace.id)) {
        access = "guest";
      }
      return { workspace, access };
    })
    .filter((item) => item.access !== "none");
};

export const defaultWorkspace = (db: Kysely<Database>) =>
  db
    .selectFrom("workspaces")
    .selectAll()
    .where("slug", "=", "default")
    .executeTakeFirstOrThrow();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * the workspace a request is about (query parameter "workspace": id or
 * slug; default workspace without it), with the actor's access
 */
export const resolveWorkspace = async (
  db: Kysely<Database>,
  actor: Actor,
  value: unknown,
  minimum: WorkspaceAccess = "guest",
) => {
  let workspace: Workspace | undefined;
  if (value === undefined || value === null || value === "") {
    workspace = await defaultWorkspace(db);
  } else if (typeof value === "string") {
    workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where(UUID_RE.test(value) ? "id" : "slug", "=", value)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }
  if (!workspace) {
    throw new HttpError(
      404,
      "not_found",
      "Workspace nicht gefunden oder kein Zugriff.",
    );
  }
  const access = await workspaceAccess(db, actor, workspace);
  if (access === "none") {
    throw new HttpError(
      404,
      "not_found",
      "Workspace nicht gefunden oder kein Zugriff.",
    );
  }
  if (!atLeastWorkspace(access, minimum)) {
    throw new HttpError(
      403,
      "forbidden",
      "Dafür fehlen dir die Rechte in diesem Workspace.",
    );
  }
  return { workspace, access };
};
