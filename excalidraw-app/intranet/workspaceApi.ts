/**
 * Intranet fork: typed client for the workspace API of excalidraw-server.
 */
import { BackendError, backendFetch } from "./api";

export type Role = "none" | "viewer" | "editor" | "manager";
export type PrincipalType = "user" | "group";

export interface CollectionInfo {
  id: string;
  name: string;
  kind: "personal" | "team";
  /** the collection above (W4), if this person sees it */
  parentId?: string | null;
  role: Role;
  sceneCount: number;
}

export interface SceneSummary {
  id: string;
  name: string;
  collection: { id: string; name: string; kind: "personal" | "team" } | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  thumbnailUrl: string | null;
  hasReadLink: boolean;
  activeUsers: { id: string; name: string }[];
  /** the current user's rights (in scene lists) */
  role?: "viewer" | "editor";
  canManage?: boolean;
}

export interface OpenedScene extends SceneSummary {
  role: "viewer" | "editor";
  canManage: boolean;
}

export interface Grant {
  type: PrincipalType;
  principal: string;
  role: Exclude<Role, "none">;
  /** display name (users) or group path */
  label: string;
}

export interface DirectoryResult {
  users: {
    id: string;
    name: string;
    email: string | null;
    username: string | null;
  }[];
  groups: string[];
}

export type SceneListQuery = (
  | { view: "recent"; q?: string }
  | { view: "shared"; q?: string; sort?: SceneSort }
  | { collection: string; q?: string; sort?: SceneSort }
) & { workspace?: string };

export interface WorkspacePolicies {
  readLinks: boolean;
  directSharing: boolean;
  collectionCreation: "members" | "admins";
  export: boolean;
  trashRetentionDays: number;
  embeds: boolean;
  embedsWithoutLogin: boolean;
}

/** guest: sees only what was shared with them in this workspace */
export type WorkspaceAccess = "guest" | "member" | "admin";

export interface WorkspaceInfo {
  id: string;
  slug: string;
  name: string;
  access: WorkspaceAccess;
}

export interface WorkspaceOverview {
  workspace: WorkspaceInfo & { policies: WorkspacePolicies };
  workspaces: WorkspaceInfo[];
  collections: CollectionInfo[];
}

export interface TrashedScene extends SceneSummary {
  deletedAt: string;
  deletedBy: string | null;
  purgeAt: string;
}

export interface SearchResult extends SceneSummary {
  /** where the words occur: a text of the drawing or a comment */
  snippet: { kind: "drawing" | "comment"; text: string } | null;
}

export interface ActivityEvent {
  id: string;
  at: string;
  type: string;
  actor: Person | null;
  scene: { id: string; name: string | null; available: boolean } | null;
  collectionId: string | null;
  details: {
    name?: string;
    before?: string;
    count?: number;
    via?: string;
  };
}

export interface VersionInfo {
  id: string;
  savedAt: string;
  savedBy: string | null;
  size: number;
  reason: "auto" | "restore" | "import";
}

export type SceneSort = "updated" | "created" | "name";

export interface ApiTokenInfo {
  id: string;
  name: string;
  scope: "read" | "write";
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  expired: boolean;
}

export interface Person {
  id: string;
  name: string;
}

export interface CommentInfo {
  id: string;
  text: string;
  author: Person | null;
  mentions: Person[];
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface CommentThread {
  id: string;
  sceneId: string;
  /** scene coordinates; relative to the element's top left with elementId */
  x: number;
  y: number;
  elementId: string | null;
  createdAt: string;
  createdBy: Person | null;
  updatedAt: string;
  resolved: boolean;
  resolvedBy: Person | null;
  canResolve: boolean;
  comments: CommentInfo[];
}

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      const body = await response.json();
      message =
        body.message && body.message !== body.error ? body.message : message;
    } catch {
      // keep the generic message
    }
    throw new BackendError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
};

const send = (method: string, path: string, body?: unknown) =>
  backendFetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const workspaceApi = {
  overview: async (workspace?: string) =>
    json<WorkspaceOverview>(
      await backendFetch(
        `/api/workspace${
          workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""
        }`,
      ),
    ),

  listScenes: async (query: SceneListQuery) => {
    const params = new URLSearchParams();
    if ("collection" in query) {
      params.set("collection", query.collection);
    } else {
      params.set("view", query.view);
    }
    if (query.q) {
      params.set("q", query.q);
    }
    if ("sort" in query && query.sort) {
      params.set("sort", query.sort);
    }
    if (query.workspace) {
      params.set("workspace", query.workspace);
    }
    return json<{ scenes: SceneSummary[] }>(
      await backendFetch(`/api/scenes?${params}`),
    );
  },

  createScene: async (input: {
    name?: string;
    collectionId?: string;
    workspaceId?: string;
  }) =>
    json<{ scene: SceneSummary; key: string }>(
      await send("POST", "/api/scenes", input),
    ),

  openScene: async (sceneId: string) =>
    json<{ scene: OpenedScene; key: string }>(
      await backendFetch(`/api/scenes/${encodeURIComponent(sceneId)}`),
    ),

  updateScene: async (
    sceneId: string,
    changes: { name?: string; collectionId?: string },
  ) =>
    json<{ ok: true }>(
      await send(
        "PATCH",
        `/api/scenes/${encodeURIComponent(sceneId)}`,
        changes,
      ),
    ),

  deleteScene: async (sceneId: string) =>
    json<void>(
      await send("DELETE", `/api/scenes/${encodeURIComponent(sceneId)}`),
    ),

  sceneGrants: async (sceneId: string) =>
    json<{
      grants: Grant[];
      canManage: boolean;
      collection: { id: string; name: string; kind: "personal" | "team" };
      readLinkUrl: string | null;
      embedUrl: string | null;
      policies: {
        readLinks: boolean;
        directSharing: boolean;
        embeds: boolean;
        embedsWithoutLogin: boolean;
      };
    }>(await backendFetch(`/api/scenes/${encodeURIComponent(sceneId)}/grants`)),

  setSceneGrants: async (sceneId: string, grants: Omit<Grant, "label">[]) =>
    json<{ ok: true }>(
      await send("PUT", `/api/scenes/${encodeURIComponent(sceneId)}/grants`, {
        grants,
      }),
    ),

  createReadLink: async (sceneId: string) =>
    json<{ url: string }>(
      await send(
        "POST",
        `/api/scenes/${encodeURIComponent(sceneId)}/read-link`,
      ),
    ),

  deleteReadLink: async (sceneId: string) =>
    json<void>(
      await send(
        "DELETE",
        `/api/scenes/${encodeURIComponent(sceneId)}/read-link`,
      ),
    ),

  createEmbed: async (sceneId: string) =>
    json<{ url: string }>(
      await send("POST", `/api/scenes/${encodeURIComponent(sceneId)}/embed`),
    ),

  deleteEmbed: async (sceneId: string) =>
    json<void>(
      await send("DELETE", `/api/scenes/${encodeURIComponent(sceneId)}/embed`),
    ),

  resolveReadLink: async (token: string) =>
    json<{ sceneId: string }>(
      await backendFetch(`/api/read-links/${encodeURIComponent(token)}`),
    ),

  createCollection: async (
    name: string,
    workspaceId?: string,
    parentId?: string,
  ) =>
    json<CollectionInfo>(
      await send("POST", "/api/collections", {
        name,
        workspaceId,
        ...(parentId ? { parentId } : {}),
      }),
    ),

  /** W4: into another collection, or to the top (null) */
  moveCollection: async (collectionId: string, parentId: string | null) =>
    json<{ id: string; name: string; parentId: string | null }>(
      await send("PATCH", `/api/collections/${collectionId}`, { parentId }),
    ),

  renameCollection: async (collectionId: string, name: string) =>
    json<{ id: string; name: string }>(
      await send("PATCH", `/api/collections/${collectionId}`, { name }),
    ),

  deleteCollection: async (collectionId: string) =>
    json<void>(await send("DELETE", `/api/collections/${collectionId}`)),

  collectionGrants: async (collectionId: string) =>
    json<{
      grants: Grant[];
      /** W4: access through the collections above (unnamed if not visible) */
      inherited?: {
        collection: { id: string; name: string } | null;
        grants: Grant[];
      }[];
      canManage: boolean;
    }>(await backendFetch(`/api/collections/${collectionId}/grants`)),

  setCollectionGrants: async (
    collectionId: string,
    grants: Omit<Grant, "label">[],
  ) =>
    json<{ ok: true }>(
      await send("PUT", `/api/collections/${collectionId}/grants`, { grants }),
    ),

  tokens: async () =>
    json<{
      allowed: boolean;
      maxDays: number;
      loginMaxAgeDays: number;
      mcpEnabled: boolean;
      tokens: ApiTokenInfo[];
    }>(await backendFetch("/api/tokens")),

  createToken: async (input: {
    name: string;
    scope: "read" | "write";
    expiresInDays: number;
  }) =>
    json<ApiTokenInfo & { token: string }>(
      await send("POST", "/api/tokens", input),
    ),

  revokeToken: async (tokenId: string) =>
    json<void>(
      await send("DELETE", `/api/tokens/${encodeURIComponent(tokenId)}`),
    ),

  comments: async (sceneId: string) =>
    json<{ threads: CommentThread[] }>(
      await backendFetch(`/api/scenes/${encodeURIComponent(sceneId)}/comments`),
    ),

  createThread: async (
    sceneId: string,
    input: {
      x: number;
      y: number;
      elementId: string | null;
      text: string;
      mentions?: string[];
    },
  ) =>
    json<{ thread: CommentThread }>(
      await send(
        "POST",
        `/api/scenes/${encodeURIComponent(sceneId)}/comments`,
        input,
      ),
    ),

  replyToThread: async (
    threadId: string,
    input: { text: string; mentions?: string[] },
  ) =>
    json<{ thread: CommentThread }>(
      await send(
        "POST",
        `/api/comment-threads/${encodeURIComponent(threadId)}/comments`,
        input,
      ),
    ),

  resolveThread: async (threadId: string, resolved: boolean) =>
    json<{ thread: CommentThread }>(
      await send(
        "PATCH",
        `/api/comment-threads/${encodeURIComponent(threadId)}`,
        { resolved },
      ),
    ),

  editComment: async (commentId: string, text: string) =>
    json<{ thread: CommentThread }>(
      await send("PATCH", `/api/comments/${encodeURIComponent(commentId)}`, {
        text,
      }),
    ),

  deleteComment: async (commentId: string) =>
    json<void>(
      await send("DELETE", `/api/comments/${encodeURIComponent(commentId)}`),
    ),

  // --- phase 4: trash, activity, search, export, versions ---------------

  trash: async (workspace: string) =>
    json<{ scenes: TrashedScene[] }>(
      await backendFetch(
        `/api/scenes?view=trash&workspace=${encodeURIComponent(workspace)}`,
      ),
    ),

  restoreScene: async (sceneId: string) =>
    json<{ scene: SceneSummary }>(
      await send("POST", `/api/scenes/${encodeURIComponent(sceneId)}/restore`),
    ),

  purgeScene: async (sceneId: string) =>
    json<void>(
      await send("DELETE", `/api/scenes/${encodeURIComponent(sceneId)}/purge`),
    ),

  activity: async (workspace: string, before?: string) =>
    json<{ events: ActivityEvent[]; next: string | null }>(
      await backendFetch(
        `/api/activity?workspace=${encodeURIComponent(workspace)}${
          before ? `&before=${encodeURIComponent(before)}` : ""
        }`,
      ),
    ),

  search: async (workspace: string, q: string) =>
    json<{ total: number; results: SearchResult[] }>(
      await backendFetch(
        `/api/search?workspace=${encodeURIComponent(
          workspace,
        )}&q=${encodeURIComponent(q)}`,
      ),
    ),

  /** download link (GET with the session cookie) */
  exportUrl: (workspace: string, collectionId?: string) =>
    `/api/export?workspace=${encodeURIComponent(workspace)}${
      collectionId ? `&collection=${encodeURIComponent(collectionId)}` : ""
    }`,

  versions: async (sceneId: string) =>
    json<{
      current: { savedAt: string; savedBy: string | null; revision: number };
      versions: VersionInfo[];
      canRestore: boolean;
    }>(
      await backendFetch(`/api/scenes/${encodeURIComponent(sceneId)}/versions`),
    ),

  version: async (sceneId: string, versionId: string) =>
    json<{ id: string; savedAt: string; iv: string; ciphertext: string }>(
      await backendFetch(
        `/api/scenes/${encodeURIComponent(
          sceneId,
        )}/versions/${encodeURIComponent(versionId)}`,
      ),
    ),

  restoreVersion: async (sceneId: string, versionId: string) =>
    json<{ revision: number }>(
      await send(
        "POST",
        `/api/scenes/${encodeURIComponent(
          sceneId,
        )}/versions/${encodeURIComponent(versionId)}/restore`,
      ),
    ),

  directory: async (q: string) =>
    json<DirectoryResult>(
      await backendFetch(`/api/directory?q=${encodeURIComponent(q)}`),
    ),
};
