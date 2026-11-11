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
}

export const actorOf = (user: User): Actor => ({
  id: user.id,
  groups: user.groups,
  isAdmin: user.is_admin,
});

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
  if (actor.isAdmin) {
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

export interface SceneAccess {
  scene: Scene;
  collection: Collection;
  collectionRole: Role;
  /** viewer or editor (or none) */
  role: Role;
  canManage: boolean;
}

export const sceneAccess = async (
  db: Kysely<Database>,
  actor: Actor,
  sceneId: string,
): Promise<SceneAccess | null> => {
  const scene = await db
    .selectFrom("scenes")
    .selectAll()
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

  const role = maxRole([
    fromCollection === "manager" ? "editor" : fromCollection,
    ...direct.map((grant) => grant.role as Role),
    viaLink,
  ]);

  return {
    scene,
    collection,
    collectionRole: fromCollection,
    role,
    canManage: atLeast(fromCollection, "editor"),
  };
};

/** ids of the collections the actor can see, with their role */
export const accessibleCollections = async (
  db: Kysely<Database>,
  actor: Actor,
): Promise<{ collection: Collection; role: Role }[]> => {
  const rows = await db
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
            : eb.exists(
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
        ]),
      ]),
    )
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
