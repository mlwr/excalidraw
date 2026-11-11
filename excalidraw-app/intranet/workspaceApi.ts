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

export type SceneListQuery =
  | { view: "recent"; q?: string }
  | { view: "shared"; q?: string; sort?: SceneSort }
  | { collection: string; q?: string; sort?: SceneSort };

export type SceneSort = "updated" | "created" | "name";

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
  overview: async () =>
    json<{ collections: CollectionInfo[] }>(
      await backendFetch("/api/workspace"),
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
    return json<{ scenes: SceneSummary[] }>(
      await backendFetch(`/api/scenes?${params}`),
    );
  },

  createScene: async (input: { name?: string; collectionId?: string }) =>
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

  resolveReadLink: async (token: string) =>
    json<{ sceneId: string }>(
      await backendFetch(`/api/read-links/${encodeURIComponent(token)}`),
    ),

  createCollection: async (name: string) =>
    json<CollectionInfo>(await send("POST", "/api/collections", { name })),

  renameCollection: async (collectionId: string, name: string) =>
    json<{ id: string; name: string }>(
      await send("PATCH", `/api/collections/${collectionId}`, { name }),
    ),

  deleteCollection: async (collectionId: string) =>
    json<void>(await send("DELETE", `/api/collections/${collectionId}`)),

  collectionGrants: async (collectionId: string) =>
    json<{ grants: Grant[]; canManage: boolean }>(
      await backendFetch(`/api/collections/${collectionId}/grants`),
    ),

  setCollectionGrants: async (
    collectionId: string,
    grants: Omit<Grant, "label">[],
  ) =>
    json<{ ok: true }>(
      await send("PUT", `/api/collections/${collectionId}/grants`, { grants }),
    ),

  directory: async (q: string) =>
    json<DirectoryResult>(
      await backendFetch(`/api/directory?q=${encodeURIComponent(q)}`),
    ),
};
