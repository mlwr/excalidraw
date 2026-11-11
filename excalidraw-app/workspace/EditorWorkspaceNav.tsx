import type { OpenedScene } from "../intranet/workspaceApi";

const backIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      d="M15 6l-6 6 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** top-left of the editor: back to the dashboard and what is open */
export const EditorWorkspaceNav = ({
  scene,
}: {
  scene: OpenedScene | null;
}) => (
  <nav className="ws-theme ws-editor-nav" aria-label="Workspace">
    <a className="ws-editor-nav__back" href="/" title="Zur Übersicht">
      {backIcon}
      <span className="ws-visually-hidden">Zur Übersicht</span>
    </a>
    <span
      className="ws-editor-nav__title"
      title={
        scene?.collection
          ? `${scene.collection.name} / ${scene.name}`
          : scene?.name || "Nur in diesem Browser gespeichert"
      }
    >
      {scene ? scene.name : "Lokale Zeichnung"}
    </span>
    {scene?.role === "viewer" && <span className="ws-badge">Nur Ansicht</span>}
  </nav>
);
