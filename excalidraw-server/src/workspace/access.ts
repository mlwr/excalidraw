import { sql } from "kysely";

import type {
  Collection,
  Database,
  GrantRole,
  Scene,
  User,
} from "../db/schema.js";
import type { Kysely, RawBuilder } from "kysely";

/**
 * Access model of the workspace.
 *
 * - personal collection ("Meine Szenen"): only its owner (manager)
 * - team collection: grants for users or Keycloak groups (viewer, editor,
 *   manager); workspace admins manage every team collection
 * - scene: role from its collection, plus direct grants (viewer, editor),
 *   plus viewer through a valid read-only link
 * - managing a scene (share, move, delete) needs editor rights on its
 *   collection; direct scene grants never allow re-sharing
 */

export type Role = "none" | "viewer" | "editor" | "manager";

const RANK: Record<Role, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  manager: 3,
};

export const atLeast = (role: Role, minimum: Role) =>
  RANK[role] >= RANK[minimum];

export const maxRole = (roles: Role[]): Role =>
  roles.reduce<Role>(
    (best, role) => (RANK[role] > RANK[best] ? role : best),
    "none",
  );

export interface Actor {
  id: string;
  groups: string[];
  isAdmin: boolean;
  /** display name, for the activity feed and the audit log */
  name?: string;
}

export const actorOf = (user: User): Actor => ({
  id: user.id,
  groups: user.groups,
  isAdmin: user.is_admin,
  name: user.name,
});

/** admins of a workspace manage all of its team collections */
const workspaceAdmin = async (
  db: Kysely<Database>,
  actor: Actor,
  workspaceId: string,
) =>
  !!(await db
    .selectFrom("workspace_members")
    .select("role")
    .where("workspace_id", "=", workspaceId)
    .where("role", "=", "admin")
    .where(grantMatches(actor))
    .executeTakeFirst());

/** SQL condition: a grant row (principal_type, principal) matches the actor */
export const grantMatches = (actor: Actor): RawBuilder<boolean> =>
  sql<boolean>`((principal_type = 'user' and principal = ${actor.id}) or (principal_type = 'group' and principal = any(${actor.groups}::text[])))`;

/** deepest nesting of team collections (W4): Abteilung › Projekt › Thema › … */
export const MAX_COLLECTION_DEPTH = 5;

/**
 * A collection and the ones above it (W4), nearest first. Longer chains than
 * the nesting allows cannot exist; the bound only guards the query.
 */
export const collectionChain = async (
  db: Kysely<Database>,
  collectionId: string,
) =>
  (
    await sql<{
      id: string;
      parent_id: string | null;
      deleted_at: Date | null;
    }>`
      with recursive chain as (
        select id, parent_id, deleted_at, 0 as depth
        from collections where id = ${collectionId}
        union all
        select c.id, c.parent_id, c.deleted_at, chain.depth + 1
        from collections c join chain on c.id = chain.parent_id
        where chain.depth < 16
      )
      select id, parent_id, deleted_at from chain order by depth
    `.execute(db)
  ).rows;

export const collectionRole = async (
  db: Kysely<Database>,
  actor: Actor,
  collection: Collection,
): Promise<Role> => {
  if (collection.deleted_at) {
    return "none";
  }
  if (collection.kind === "personal") {
    return collection.owner_id === actor.id ? "manager" : "none";
  }
  if (
    actor.isAdmin ||
    (await workspaceAdmin(db, actor, collection.workspace_id))
  ) {
    return "manager";
  }
  // W4: grants on the collections above count here, too
  let ids = [collection.id];
  if (collection.parent_id) {
    const chain = await collectionChain(db, collection.id);
    // (the collection's own state is the one passed in)
    if (chain.slice(1).some((row) => row.deleted_at)) {
      return "none";
    }
    ids = chain.map((row) => row.id);
  }
  const grants = await db
    .selectFrom("collection_grants")
    .select("role")
    .where("collection_id", "in", ids)
    .where(grantMatches(actor))
    .execute();
  return maxRole(grants.map((grant) => grant.role as GrantRole));
};

/** a collection and all collections below it (W4), deleted ones left out */
export const collectionSubtree = async (
  db: Kysely<Database>,
  collectionId: string,
) =>
  (
    await sql<{ id: string; depth: number }>`
      with recursive tree as (
        select id, 0 as depth from collections
        where id = ${collectionId} and deleted_at is null
        union all
        select c.id, tree.depth + 1
        from collections c join tree on c.parent_id = tree.id
        where c.deleted_at is null and tree.depth < 16
      )
      select id, depth from tree
    `.execute(db)
  ).rows;

/**
 * Collections of a workspace (deleted ones too) in which the actor may
 * edit, through own grants or those of a collection above (W4): who may
 * restore scenes from the trash.
 */
export const editableCollectionIds = async (
  db: Kysely<Database>,
  actor: Actor,
  workspaceId: string,
  isAdminHere: boolean,
) => {
  const rows = await db
    .selectFrom("collections")
    .select(["id", "kind", "owner_id", "parent_id"])
    .where("workspace_id", "=", workspaceId)
    .execute();
  const team = rows.filter((row) => row.kind === "team");
  const granted = new Set(
    team.length
      ? (
          await db
            .selectFrom("collection_grants")
            .select("collection_id")
            .where(
              "collection_id",
              "in",
              team.map((row) => row.id),
            )
            .where("role", "in", ["editor", "manager"])
            .where(grantMatches(actor))
            .execute()
        ).map((row) => row.collection_id)
      : [],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const editable = (id: string, depth = 0): boolean => {
    const row = byId.get(id);
    if (!row || depth > 16) {
      return false;
    }
    return (
      granted.has(id) || (!!row.parent_id && editable(row.parent_id, depth + 1))
    );
  };
  return rows
    .filter((row) =>
      row.kind === "personal"
        ? row.owner_id === actor.id
        : isAdminHere || editable(row.id),
    )
    .map((row) => row.id);
};

/** a scene without its (possibly large) content */
export type SceneMeta = Omit<Scene, "iv" | "ciphertext">;

/** columns of a scene without its content */
export const SCENE_META_COLUMNS = [
  "id",
  "workspace_id",
  "collection_id",
  "name",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
  "deleted_at",
  "revision",
  "scene_version",
  "key_sealed",
  "thumbnail_updated_at",
  "read_link_token",
  "embed_token",
  "deleted_by",
] as const;

export interface SceneAccess {
  scene: SceneMeta;
  collection: Collection;
  collectionRole: Role;
  /** viewer or editor (or none) */
  role: Role;
  canManage: boolean;
  /** access only through a read-only link (no collection, no grant) */
  viaLinkOnly: boolean;
}

/**
 * Sharing the workspace's policies (T5) allow. Checked where access is
 * granted, too: links and grants a policy forbids count for nothing, even
 * if they still exist (a race with switching the policy off, a scene moved
 * into the workspace).
 */
const sharingAllowed = async (db: Kysely<Database>, workspaceId: string) => {
  const workspace = await db
    .selectFrom("workspaces")
    .select("settings")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  const policies = ((workspace?.settings as Record<string, any> | undefined)
    ?.policies || {}) as { readLinks?: unknown; directSharing?: unknown };
  return {
    readLinks: policies.readLinks !== false,
    directSharing: policies.directSharing !== false,
  };
};

export const sceneAccess = async (
  db: Kysely<Database>,
  actor: Actor,
  sceneId: string,
): Promise<SceneAccess | null> => {
  const scene = await db
    .selectFrom("scenes")
    .select(SCENE_META_COLUMNS)
    .where("id", "=", sceneId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!scene) {
    return null;
  }
  const collection = await db
    .selectFrom("collections")
    .selectAll()
    .where("id", "=", scene.collection_id)
    .executeTakeFirstOrThrow();

  const fromCollection = await collectionRole(db, actor, collection);
  const direct = await db
    .selectFrom("scene_grants")
    .select("role")
    .where("scene_id", "=", sceneId)
    .where(grantMatches(actor))
    .execute();

  let viaLink: Role = "none";
  if (scene.read_link_token) {
    const viewer = await db
      .selectFrom("scene_link_viewers")
      .select("token")
      .where("scene_id", "=", sceneId)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (viewer && viewer.token === scene.read_link_token) {
      viaLink = "viewer";
    }
  }

  let grants = direct.map((grant) => grant.role as Role);
  if (grants.length || viaLink !== "none") {
    const allowed = await sharingAllowed(db, scene.workspace_id);
    grants = allowed.directSharing ? grants : [];
    viaLink = allowed.readLinks ? viaLink : "none";
  }

  const ownRole = maxRole([
    fromCollection === "manager" ? "editor" : fromCollection,
    ...grants,
  ]);
  const role = maxRole([ownRole, viaLink]);

  return {
    scene,
    collection,
    collectionRole: fromCollection,
    role,
    canManage: atLeast(fromCollection, "editor"),
    viaLinkOnly: ownRole === "none" && viaLink !== "none",
  };
};

/** ids of the collections the actor can see, with their role */
/**
 * collections the actor can see, with their role; only those of one
 * workspace if workspaceId is given
 */
export const accessibleCollections = async (
  db: Kysely<Database>,
  actor: Actor,
  workspaceId?: string,
): Promise<{ collection: Collection; role: Role }[]> => {
  let query = db
    .selectFrom("collections")
    .selectAll()
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb.and([eb("kind", "=", "personal"), eb("owner_id", "=", actor.id)]),
        eb("kind", "=", "team"),
      ]),
    );
  if (workspaceId) {
    query = query.where("workspace_id", "=", workspaceId);
  }
  const rows = await query
    .orderBy("kind", "asc")
    .orderBy("name", "asc")
    .execute();
  const team = rows.filter((row) => row.kind === "team");
  if (!team.length) {
    return rows.map((collection) => ({ collection, role: "manager" }));
  }

  // roles flow down the tree (W4): own grants, or those of a parent
  const grants = await db
    .selectFrom("collection_grants")
    .select(["collection_id", "role"])
    .where(
      "collection_id",
      "in",
      team.map((row) => row.id),
    )
    .where(grantMatches(actor))
    .execute();
  const direct = new Map<string, Role>();
  for (const grant of grants) {
    direct.set(
      grant.collection_id,
      maxRole([
        direct.get(grant.collection_id) || "none",
        grant.role as GrantRole,
      ]),
    );
  }
  const adminOf = actor.isAdmin
    ? null
    : new Set(
        (
          await db
            .selectFrom("workspace_members")
            .select("workspace_id")
            .where("role", "=", "admin")
            .where(grantMatches(actor))
            .execute()
        ).map((row) => row.workspace_id),
      );
  const byId = new Map(team.map((row) => [row.id, row]));
  const roles = new Map<string, Role>();
  const roleOf = (collection: Collection, depth = 0): Role => {
    const known = roles.get(collection.id);
    if (known) {
      return known;
    }
    let role: Role;
    if (!adminOf || adminOf.has(collection.workspace_id)) {
      role = "manager";
    } else {
      const parent = collection.parent_id
        ? byId.get(collection.parent_id)
        : undefined;
      // a parent that is gone (deleted) takes its subtree along
      role =
        collection.parent_id && !parent
          ? "none"
          : maxRole([
              direct.get(collection.id) || "none",
              parent && depth < 16 ? roleOf(parent, depth + 1) : "none",
            ]);
    }
    roles.set(collection.id, role);
    return role;
  };

  const result: { collection: Collection; role: Role }[] = [];
  for (const collection of rows) {
    const role =
      collection.kind === "personal" ? "manager" : roleOf(collection);
    if (role !== "none") {
      result.push({ collection, role });
    }
  }
  return result;
};
