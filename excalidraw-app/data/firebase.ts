/**
 * Intranet fork: storage for collaboration rooms and share-link files.
 *
 * Upstream keeps this data in Google Firebase (Firestore + Storage). Here it
 * goes to our own backend (excalidraw-server). The function names stay the
 * same so the collaboration code is unchanged. All data is still end-to-end
 * encrypted in the browser: the server only stores ciphertext.
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import {
  BackendError,
  backendFetch,
  fromBase64,
  toBase64,
} from "../intranet/api";
import {
  isRoomReadOnly,
  notifySceneSaved,
  sceneIdFromRoomId,
} from "../intranet/sceneRoom";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

/** how often a scene save is retried when someone else saved in between */
const MAX_SAVE_ATTEMPTS = 5;

type StoredScene = {
  sceneVersion: number;
  revision: number;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
};

/**
 * Storage prefixes as used by the app ("/files/rooms/<id>",
 * "files/shareLinks/<id>") mapped to backend routes.
 */
const filesApiPath = (prefix: string, fileId: FileId) => {
  const [, scope, ownerId] =
    prefix.replace(/^\/+/, "").match(/^files\/(rooms|shareLinks)\/(.+)$/) || [];
  if (!scope || !ownerId) {
    throw new Error(`unknown file storage prefix: ${prefix}`);
  }
  const sceneId = scope === "rooms" ? sceneIdFromRoomId(ownerId) : null;
  if (sceneId) {
    return `/api/scenes/${encodeURIComponent(
      sceneId,
    )}/files/${encodeURIComponent(fileId)}`;
  }
  const apiScope = scope === "shareLinks" ? "share-links" : "rooms";
  return `/api/files/${apiScope}/${encodeURIComponent(
    ownerId,
  )}/${encodeURIComponent(fileId)}`;
};

const roomSceneUrl = (roomId: string) => {
  const sceneId = sceneIdFromRoomId(roomId);
  return sceneId
    ? `/api/scenes/${encodeURIComponent(sceneId)}/content`
    : `/api/rooms/${encodeURIComponent(roomId)}/scene`;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: Pick<StoredScene, "iv" | "ciphertext">,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(data.iv, data.ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const fetchStoredScene = async (
  roomId: string,
): Promise<StoredScene | null> => {
  const response = await backendFetch(roomSceneUrl(roomId), {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new BackendError(
      response.status,
      `Loading the collaboration scene failed (${response.status})`,
    );
  }
  const body = await response.json();
  return {
    sceneVersion: body.sceneVersion,
    revision: body.revision,
    iv: fromBase64(body.iv),
    ciphertext: fromBase64(body.ciphertext),
  };
};

/** returns false if someone else saved the scene in the meantime */
const putStoredScene = async (
  roomId: string,
  scene: { sceneVersion: number; iv: Uint8Array; ciphertext: Uint8Array },
  expectedRevision: number | null,
): Promise<boolean> => {
  const response = await backendFetch(roomSceneUrl(roomId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sceneVersion: scene.sceneVersion,
      iv: toBase64(scene.iv),
      ciphertext: toBase64(scene.ciphertext),
      expectedRevision,
    }),
  });
  if (response.status === 409) {
    return false;
  }
  if (!response.ok) {
    throw new BackendError(
      response.status,
      `Saving the collaboration scene failed (${response.status})`,
    );
  }
  return true;
};

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

const createSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
  };
};

// -----------------------------------------------------------------------------

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  const roomId = prefix.replace(/^\/+/, "").split("/")[2];
  if (isRoomReadOnly(roomId)) {
    return { savedFiles, erroredFiles };
  }

  // network errors and expired sessions reject the whole save so the caller
  // can tell the user (share links ignore `erroredFiles`, collab never
  // retries them); rejected uploads are reported per file
  await Promise.all(
    files.map(async ({ id, buffer }) => {
      const response = await backendFetch(filesApiPath(prefix, id), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: buffer as Uint8Array<ArrayBuffer>,
      });
      if (response.ok) {
        savedFiles.push(id);
      } else {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements) ||
    // viewers of workspace scenes only watch
    isRoomReadOnly(roomId)
  ) {
    return null;
  }

  // optimistic concurrency: read, reconcile with what others saved, write
  // with the revision we based on; retry if someone was faster
  let storedDocument: Awaited<ReturnType<typeof createSceneDocument>> | null =
    null;
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const previous = await fetchStoredScene(roomId);

    if (!previous) {
      const document = await createSceneDocument(elements, roomKey);
      if (await putStoredScene(roomId, document, null)) {
        storedDocument = document;
        break;
      }
      continue;
    }

    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(previous, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );
    const document = await createSceneDocument(reconciledElements, roomKey);
    if (await putStoredScene(roomId, document, previous.revision)) {
      storedDocument = document;
      break;
    }
  }

  if (!storedDocument) {
    throw new Error(
      "Saving the collaboration scene failed: too many concurrent changes",
    );
  }

  // Return the stored elements as the in memory `reconciledElements` could
  // have mutated in the meantime
  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedDocument, roomKey), null),
  );

  SceneVersionCache.set(socket, storedElements);

  const sceneId = sceneIdFromRoomId(roomId);
  if (sceneId) {
    notifySceneSaved(sceneId);
  }

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const storedScene = await fetchStoredScene(roomId);
  if (!storedScene) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    SceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await backendFetch(filesApiPath(prefix, id));
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

/**
 * Intranet fork: initial content of a new workspace scene (import, "save to
 * workspace"). Encrypted with the scene key like every later save.
 */
export const storeNewSceneContent = async (
  roomId: string,
  roomKey: string,
  elements: readonly SyncableExcalidrawElement[],
) => {
  const document = await createSceneDocument(elements, roomKey);
  if (!(await putStoredScene(roomId, document, null))) {
    throw new Error("The scene already has content");
  }
};
