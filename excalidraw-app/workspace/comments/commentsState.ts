import { atom } from "../../app-jotai";

import type { CommentThread } from "../../intranet/workspaceApi";

/** comment threads of the open workspace scene (null: not loaded yet) */
export const commentThreadsAtom = atom<CommentThread[] | null>(null);

/** the list of comments next to the canvas */
export const commentsPanelOpenAtom = atom(false);

/** waiting for a click on the canvas to place a new comment */
export const commentPlacingAtom = atom(false);

/** the thread shown in a popover next to its pin */
export const openThreadIdAtom = atom<string | null>(null);
