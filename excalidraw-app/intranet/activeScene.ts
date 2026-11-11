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
