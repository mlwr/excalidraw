import clsx from "clsx";

import { useAtom, useAtomValue } from "../../app-jotai";

import { commentThreadsAtom, commentsPanelOpenAtom } from "./commentsState";

const commentIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

/** top right of the editor: show or hide the comments of the scene */
export const CommentsButton = () => {
  const [open, setOpen] = useAtom(commentsPanelOpenAtom);
  const threads = useAtomValue(commentThreadsAtom);
  const unresolved = threads?.filter((thread) => !thread.resolved).length || 0;
  return (
    <button
      type="button"
      className={clsx("ws-theme ws-comments-button", open && "is-active")}
      title="Kommentare"
      aria-label={`Kommentare${unresolved ? ` (${unresolved} offen)` : ""}`}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    >
      {commentIcon}
      {unresolved > 0 && (
        <span className="ws-comments-button__count">{unresolved}</span>
      )}
    </button>
  );
};
