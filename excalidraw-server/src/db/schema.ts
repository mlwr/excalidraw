import type { ColumnType, Generated, Insertable, Selectable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  oidc_issuer: string;
  oidc_subject: string;
  email: string | null;
  name: string;
  username: string | null;
  roles: ColumnType<string[], string[] | undefined, string[]>;
  groups: ColumnType<string[], string[] | undefined, string[]>;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  last_login_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  disabled_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
}

export interface SessionsTable {
  /** sha256 of the cookie token, never the token itself */
  id: string;
  user_id: string;
  /** Keycloak session id (`sid` claim), used for back-channel logout */
  oidc_sid: string | null;
  id_token: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  user_agent: string | null;
}

export interface LoginStatesTable {
  /** sha256 of the cookie value */
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  created_at: Timestamp;
}

export interface WorkspacesTable {
  id: Generated<string>;
  slug: string;
  name: string;
  created_at: Timestamp;
}

/** end-to-end encrypted scene of an ad-hoc collaboration room */
export interface RoomsTable {
  id: string;
  workspace_id: string | null;
  created_by: string | null;
  scene_version: ColumnType<string, number | string, number | string>;
  revision: ColumnType<string, number | string, number | string>;
  iv: Buffer;
  ciphertext: Buffer;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** end-to-end encrypted snapshot behind a "#json=" share link */
export interface ShareLinksTable {
  id: string;
  created_by: string | null;
  payload: Buffer;
  created_at: Timestamp;
}

/** binary objects of the "postgres" storage driver */
export interface BlobsTable {
  key: string;
  data: Buffer;
  size: number;
  content_type: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export type GrantRole = "viewer" | "editor" | "manager";
export type PrincipalType = "user" | "group";

export interface CollectionsTable {
  id: Generated<string>;
  workspace_id: string;
  name: string;
  kind: "personal" | "team";
  owner_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface CollectionGrantsTable {
  collection_id: string;
  principal_type: PrincipalType;
  principal: string;
  role: GrantRole;
  created_by: string | null;
  created_at: Timestamp;
}

export interface ScenesTable {
  id: string;
  workspace_id: string;
  collection_id: string;
  name: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  revision: ColumnType<string, number | string | undefined, number | string>;
  scene_version: ColumnType<
    string,
    number | string | undefined,
    number | string
  >;
  iv: Buffer | null;
  ciphertext: Buffer | null;
  key_sealed: Buffer;
  thumbnail_updated_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  read_link_token: string | null;
}

export interface SceneGrantsTable {
  scene_id: string;
  principal_type: PrincipalType;
  principal: string;
  role: Exclude<GrantRole, "manager">;
  created_by: string | null;
  created_at: Timestamp;
}

export interface SceneVisitsTable {
  user_id: string;
  scene_id: string;
  visited_at: Timestamp;
}

export interface SceneLinkViewersTable {
  scene_id: string;
  user_id: string;
  token: string;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  login_states: LoginStatesTable;
  workspaces: WorkspacesTable;
  rooms: RoomsTable;
  share_links: ShareLinksTable;
  blobs: BlobsTable;
  collections: CollectionsTable;
  collection_grants: CollectionGrantsTable;
  scenes: ScenesTable;
  scene_grants: SceneGrantsTable;
  scene_visits: SceneVisitsTable;
  scene_link_viewers: SceneLinkViewersTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Collection = Selectable<CollectionsTable>;
export type Scene = Selectable<ScenesTable>;
