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
  const grants = await db
    .selectFrom("collection_grants")
    .select("role")
    .where("collection_id", "=", collection.id)
    .where(grantMatches(actor))
    .execute();
  return maxRole(grants.map((grant) => grant.role as GrantRole));
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
        eb.and([
          eb("kind", "=", "team"),
          actor.isAdmin
            ? sql<boolean>`true`
            : eb.or([
                eb.exists(
                  eb
                    .selectFrom("collection_grants")
                    .select(sql`1`.as("one"))
                    .whereRef(
                      "collection_grants.collection_id",
                      "=",
                      "collections.id",
                    )
                    .where(grantMatches(actor)),
                ),
                eb.exists(
                  eb
                    .selectFrom("workspace_members")
                    .select(sql`1`.as("one"))
                    .whereRef(
                      "workspace_members.workspace_id",
                      "=",
                      "collections.workspace_id",
                    )
                    .where("workspace_members.role", "=", "admin")
                    .where(grantMatches(actor)),
                ),
              ]),
        ]),
      ]),
    );
  if (workspaceId) {
    query = query.where("workspace_id", "=", workspaceId);
  }
  const rows = await query
    .orderBy("kind", "asc")
    .orderBy("name", "asc")
    .execute();

  const result: { collection: Collection; role: Role }[] = [];
  for (const collection of rows) {
    result.push({
      collection,
      role: await collectionRole(db, actor, collection),
    });
  }
  return result;
};
