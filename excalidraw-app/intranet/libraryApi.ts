/**
 * Intranet fork: libraries on the server (L1, L2).
 *
 * - The personal library lives with the account (`ServerLibraryAdapter`),
 *   what was in this browser's library moves there once.
 * - Team and company libraries are separate lists in their own sidebar tab.
 */

import type {
  LibraryItems,
  LibraryItems_anyVersion,
} from "@excalidraw/excalidraw/types";
import type {
  LibraryMigrationAdapter,
  LibraryPersistenceAdapter,
} from "@excalidraw/excalidraw/data/library";

import { BackendError, backendFetch } from "./api";

export interface SharedLibraryInfo {
  id: string;
  kind: "personal" | "collection" | "workspace";
  name: string;
  scope: { id: string; name: string } | null;
  canEdit: boolean;
  items: number;
  revision: number;
  updatedAt: string;
}

export interface LibraryList {
  libraries: SharedLibraryInfo[];
  canCreate: {
    collections: { id: string; name: string }[];
    workspaces: { id: string; name: string }[];
  };
}

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      message = (await response.json()).message || message;
    } catch {
      // keep the generic message
    }
    throw new BackendError(response.status, message);
  }
  return (response.status === 204 ? undefined : response.json()) as T;
};

const send = (method: string, path: string, body?: unknown) =>
  backendFetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const libraryApi = {
  list: async () => json<LibraryList>(await backendFetch("/api/libraries")),

  get: async (id: string) =>
    json<{ library: SharedLibraryInfo; libraryItems: LibraryItems }>(
      await backendFetch(`/api/libraries/${encodeURIComponent(id)}`),
    ),

  /** with expectedRevision: 409 if someone else saved in between */
  save: async (
    id: string,
    libraryItems: LibraryItems_anyVersion,
    expectedRevision?: number,
  ) =>
    json<{ revision: number }>(
      await send("PUT", `/api/libraries/${encodeURIComponent(id)}`, {
        libraryItems,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    ),

  create: async (
    name: string,
    scope: { collectionId: string } | { workspaceId: string },
  ) =>
    json<{ library: SharedLibraryInfo }>(
      await send("POST", "/api/libraries", { name, ...scope }),
    ),

  rename: async (id: string, name: string) =>
    json<{ library: SharedLibraryInfo }>(
      await send("PATCH", `/api/libraries/${encodeURIComponent(id)}`, { name }),
    ),

  remove: async (id: string) =>
    json<void>(
      await send("DELETE", `/api/libraries/${encodeURIComponent(id)}`),
    ),
};

/** the personal library, stored with the account */
export const ServerLibraryAdapter: LibraryPersistenceAdapter = {
  load: async () => {
    const { libraryItems } = await libraryApi.get("personal");
    return { libraryItems };
  },
  save: async ({ libraryItems }) => {
    await libraryApi.save("personal", libraryItems);
  },
};

const MIGRATED_KEY = "excalidraw-library-on-server";

/**
 * Once per browser: what this browser kept in its own library goes into
 * the personal library on the server. The browser's copy stays (the local
 * editor without the server still uses it).
 */
export const createBrowserLibraryMigration = (
  loadBrowserLibrary: () => Promise<{
    libraryItems: LibraryItems_anyVersion;
  } | null>,
): LibraryMigrationAdapter => ({
  load: async () => {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) {
        return null;
      }
    } catch {
      return null;
    }
    const data = await loadBrowserLibrary();
    return data?.libraryItems?.length ? data : null;
  },
  clear: () => {
    try {
      localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
    } catch {
      // the next start offers the same items again; merging keeps no doubles
    }
  },
});
