/**
 * Intranet fork: spotlight (Z4). One person takes the spotlight, everyone
 * else in the live session follows their view (the follow mode of the
 * editor, started for them). Whoever stops following stays out until the
 * spotlight ends.
 */
import type { SocketId } from "@excalidraw/excalidraw/types";

import { atom } from "../app-jotai";

export interface SpotlightState {
  /** I have the spotlight */
  presenting: boolean;
  /** how many follow me */
  followers: number;
  /** someone else has the spotlight */
  presenter: { socketId: SocketId; username: string } | null;
  /** I stopped following that presenter */
  optedOut: boolean;
}

export const spotlightAtom = atom<SpotlightState>({
  presenting: false,
  followers: 0,
  presenter: null,
  optedOut: false,
});

/** how often the presenter repeats the spotlight (for people who join) */
export const SPOTLIGHT_HEARTBEAT_MS = 5000;
