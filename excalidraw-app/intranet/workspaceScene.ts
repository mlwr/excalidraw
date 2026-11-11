/**
 * Intranet fork: editor-side helpers for workspace scenes (thumbnails, new
 * scenes from existing drawings).
 */
import { exportScene } from "@excalidraw/excalidraw";
import { getSceneVersion } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from "../data";
import { encodeFilesForUpload } from "../data/FileManager";
import { saveFilesToFirebase, storeNewSceneContent } from "../data/firebase";

import { backendFetch } from "./api";
import { getActiveScene } from "./activeScene";
import { onSceneSaved, sceneRoomId } from "./sceneRoom";
import { getMaxFileUploadBytes } from "./session";
import { workspaceApi } from "./workspaceApi";

// -----------------------------------------------------------------------------
// thumbnails for the dashboard
// -----------------------------------------------------------------------------

const THUMBNAIL_MIN_INTERVAL_MS = 30 * 1000;
const THUMBNAIL_DELAY_MS = 4 * 1000;
const THUMBNAIL_SIZE = 480;

let editorAPI: ExcalidrawImperativeAPI | null = null;
let thumbnailTimer: number | null = null;
let lastThumbnailAt = 0;
let lastThumbnailVersion = -1;

const uploadThumbnail = async () => {
  thumbnailTimer = null;
  const scene = getActiveScene();
  if (!scene || scene.role === "viewer" || !editorAPI) {
    return;
  }
  const elements = editorAPI.getSceneElements();
  const version = getSceneVersion(elements);
  if (!elements.length || version === lastThumbnailVersion) {
    return;
  }
  try {
    const blob = await exportScene({
      type: "png",
      data: {
        elements,
        appState: {
          viewBackgroundColor: editorAPI.getAppState().viewBackgroundColor,
        },
        files: editorAPI.getFiles(),
      },
      config: { maxWidthOrHeight: THUMBNAIL_SIZE },
    });
    await backendFetch(
      `/api/scenes/${encodeURIComponent(scene.id)}/thumbnail`,
      {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: blob,
      },
    );
    lastThumbnailAt = Date.now();
    lastThumbnailVersion = version;
  } catch (error) {
    // thumbnails are a convenience; never disturb drawing
    console.warn("thumbnail upload failed", error);
  }
};

const scheduleThumbnail = () => {
  if (thumbnailTimer !== null) {
    window.clearTimeout(thumbnailTimer);
  }
  const sinceLast = Date.now() - lastThumbnailAt;
  thumbnailTimer = window.setTimeout(
    uploadThumbnail,
    Math.max(THUMBNAIL_DELAY_MS, THUMBNAIL_MIN_INTERVAL_MS - sinceLast),
  );
};

/** connects the editor so that saved scenes get a fresh thumbnail */
export const registerEditorForThumbnails = (api: ExcalidrawImperativeAPI) => {
  editorAPI = api;
  const unsubscribe = onSceneSaved((sceneId) => {
    if (sceneId === getActiveScene()?.id) {
      scheduleThumbnail();
    }
  });
  const onHide = () => {
    if (document.visibilityState === "hidden" && thumbnailTimer !== null) {
      window.clearTimeout(thumbnailTimer);
      uploadThumbnail();
    }
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onHide);
  };
};

// -----------------------------------------------------------------------------
// new scenes from existing drawings (import, "save to workspace")
// -----------------------------------------------------------------------------

export const createSceneFromDrawing = async ({
  name,
  collectionId,
  elements,
  files,
}: {
  name: string;
  collectionId?: string;
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
}) => {
  const { scene, key } = await workspaceApi.createScene({ name, collectionId });
  const roomId = sceneRoomId(scene.id);

  const syncable = getSyncableElements(
    elements.filter(
      (element) => !element.isDeleted,
    ) as OrderedExcalidrawElement[],
  );
  await storeNewSceneContent(roomId, key, syncable);

  const usedFiles = new Map<FileId, BinaryFileData>();
  for (const element of syncable) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      usedFiles.set(element.fileId, files[element.fileId]);
    }
  }
  if (usedFiles.size) {
    await saveFilesToFirebase({
      prefix: `files/rooms/${roomId}`,
      files: await encodeFilesForUpload({
        files: usedFiles,
        encryptionKey: key,
        maxBytes: getMaxFileUploadBytes(),
      }),
    });
  }
  return scene;
};
