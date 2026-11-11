/**
 * Intranet fork: workspace scenes reuse the live-collaboration machinery.
 * Their room id is "scene-<sceneId>"; the room key comes from the server
 * (only for people with access) instead of the URL.
 *
 * This module has no dependencies so that the data layer can use it.
 */

export const SCENE_ROOM_PREFIX = "scene-";

export const sceneRoomId = (sceneId: string) =>
  `${SCENE_ROOM_PREFIX}${sceneId}`;

export const sceneIdFromRoomId = (roomId: string | null | undefined) =>
  roomId && roomId.startsWith(SCENE_ROOM_PREFIX)
    ? roomId.slice(SCENE_ROOM_PREFIX.length)
    : null;

const readOnlyRooms = new Set<string>();

/** rooms of scenes the current user may only view */
export const setRoomReadOnly = (roomId: string, readOnly: boolean) => {
  if (readOnly) {
    readOnlyRooms.add(roomId);
  } else {
    readOnlyRooms.delete(roomId);
  }
};

export const isRoomReadOnly = (roomId: string | null | undefined) =>
  !!roomId && readOnlyRooms.has(roomId);

type SavedListener = (sceneId: string) => void;
const savedListeners = new Set<SavedListener>();

/** called after a workspace scene was saved to the server */
export const onSceneSaved = (listener: SavedListener) => {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
};

export const notifySceneSaved = (sceneId: string) => {
  savedListeners.forEach((listener) => listener(sceneId));
};
