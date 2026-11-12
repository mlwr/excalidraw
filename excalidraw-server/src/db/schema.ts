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
  erased_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
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
  /** everybody who may use the app is a member (the default workspace) */
  open_to_all: ColumnType<boolean, boolean | undefined, boolean>;
  /** policies, see workspace/policies.ts */
  settings: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  created_by: string | null;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export type WorkspaceRole = "member" | "admin";

export interface WorkspaceMembersTable {
  workspace_id: string;
  principal_type: PrincipalType;
  principal: string;
  role: WorkspaceRole;
  created_by: string | null;
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
  /** token of the embedding link (T3) */
  embed_token: string | null;
  deleted_by: string | null;
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

export type TokenScope = "read" | "write";

export interface ApiTokensTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  token_hash: string;
  token_hint: string;
  scope: TokenScope;
  created_at: Timestamp;
  last_used_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface CommentThreadsTable {
  id: Generated<string>;
  scene_id: string;
  x: number;
  y: number;
  element_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  resolved_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  resolved_by: string | null;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface CommentsTable {
  id: Generated<string>;
  thread_id: string;
  author_id: string | null;
  body: Buffer;
  mentions: ColumnType<string[], string[] | undefined, string[]>;
  created_at: Timestamp;
  edited_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface SceneVersionsTable {
  id: Generated<string>;
  scene_id: string;
  created_at: Timestamp;
  taken_at: Timestamp;
  created_by: string | null;
  revision: ColumnType<string, number | string, number | string>;
  scene_version: ColumnType<string, number | string, number | string>;
  iv: Buffer;
  ciphertext: Buffer;
  size: number;
  reason: ColumnType<
    "auto" | "restore" | "import",
    "auto" | "restore" | "import" | undefined,
    "auto" | "restore" | "import"
  >;
}

export interface SceneSearchTable {
  scene_id: string;
  tokens: ColumnType<string[], string[] | undefined, string[]>;
  indexed_revision: ColumnType<
    string,
    number | string | undefined,
    number | string
  >;
  indexed_at: Timestamp;
  /** comments changed after indexed_at: index again */
  dirty_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface EventsTable {
  id: Generated<string>;
  at: Timestamp;
  actor_id: string | null;
  actor_name: string | null;
  type: string;
  workspace_id: string | null;
  collection_id: string | null;
  scene_id: string | null;
  target: string | null;
  data: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  ip: string | null;
  user_agent: string | null;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** AI usage of past days: sums only, no persons */
export interface AiUsageDailyTable {
  day: ColumnType<string, string, string>;
  requests: number;
  people: number;
  prompt_tokens: ColumnType<string, number | string, number | string>;
  completion_tokens: ColumnType<string, number | string, number | string>;
}

export interface AiUsageTable {
  user_id: string;
  /** yyyy-mm-dd */
  day: ColumnType<string, string, string>;
  feature: string;
  requests: ColumnType<number, number | undefined, number>;
  prompt_tokens: ColumnType<
    string,
    number | string | undefined,
    number | string
  >;
  completion_tokens: ColumnType<
    string,
    number | string | undefined,
    number | string
  >;
}

export type LibraryKind = "personal" | "collection" | "workspace";

export interface LibrariesTable {
  id: Generated<string>;
  kind: LibraryKind;
  owner_id: string | null;
  collection_id: string | null;
  workspace_id: string | null;
  name: string;
  key_sealed: Buffer;
  /** encrypted JSON list of library items */
  content: Buffer | null;
  items: ColumnType<number, number | undefined, number>;
  size: ColumnType<number, number | undefined, number>;
  revision: ColumnType<string, number | string | undefined, number | string>;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  type: string;
  actor_id: string | null;
  scene_id: string | null;
  collection_id: string | null;
  thread_id: string | null;
  data: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string | undefined,
    Record<string, unknown> | string
  >;
  created_at: Timestamp;
  read_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  email_state: ColumnType<
    "none" | "pending" | "sent" | "failed",
    "none" | "pending" | "sent" | "failed" | undefined,
    "none" | "pending" | "sent" | "failed"
  >;
}

export interface UserPreferencesTable {
  user_id: string;
  preferences: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string | undefined,
    Record<string, unknown> | string
  >;
  updated_at: Timestamp;
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
  api_tokens: ApiTokensTable;
  comment_threads: CommentThreadsTable;
  comments: CommentsTable;
  workspace_members: WorkspaceMembersTable;
  scene_versions: SceneVersionsTable;
  scene_search: SceneSearchTable;
  events: EventsTable;
  settings: SettingsTable;
  ai_usage: AiUsageTable;
  ai_usage_daily: AiUsageDailyTable;
  libraries: LibrariesTable;
  notifications: NotificationsTable;
  user_preferences: UserPreferencesTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Collection = Selectable<CollectionsTable>;
export type Scene = Selectable<ScenesTable>;
export type ApiToken = Selectable<ApiTokensTable>;
export type CommentThread = Selectable<CommentThreadsTable>;
export type Comment = Selectable<CommentsTable>;
export type Workspace = Selectable<WorkspacesTable>;
export type SceneVersion = Selectable<SceneVersionsTable>;
export type EventRow = Selectable<EventsTable>;
