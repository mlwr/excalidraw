/**
 * Intranet fork: the workspace scene opened in the editor (route /s/<id>).
 * Kept free of editor imports so the start page loads without the editor.
 */
import { sceneRoomId, setRoomReadOnly } from "./sceneRoom";

import type { OpenedScene } from "./workspaceApi";

export type ActiveScene = OpenedScene & { key: string };

let activeScene: ActiveScene | null = null;

export const getActiveScene = () => activeScene;

export const setActiveScene = (scene: ActiveScene) => {
  activeScene = scene;
  setRoomReadOnly(sceneRoomId(scene.id), scene.role === "viewer");
  document.title = `${scene.name} · Excalidraw`;
};

/** room data for the collaboration layer */
export const activeSceneRoom = () =>
  activeScene
    ? { roomId: sceneRoomId(activeScene.id), roomKey: activeScene.key }
    : null;

const RELOAD_MARK = "excalidraw-scene-reload";

/**
 * The server ended the live connection to the scene: access changed, the
 * scene was deleted or the session ended. Reloading opens it again with the
 * current rights (or explains why it is gone). Returns false instead of
 * reloading twice within a few seconds.
 */
export const reloadActiveScene = () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_MARK) || 0);
    if (Date.now() - last < 10000) {
      return false;
    }
    sessionStorage.setItem(RELOAD_MARK, String(Date.now()));
  } catch {
    // storage blocked: reload anyway
  }
  window.location.reload();
  return true;
};
