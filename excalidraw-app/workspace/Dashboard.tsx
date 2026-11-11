import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LOCAL_EDITOR_PATH, scenePath } from "../intranet/routes";
import { getCurrentUser, logout } from "../intranet/session";
import { workspaceApi } from "../intranet/workspaceApi";

import {
  CollectionAccessDialog,
  ConfirmDialog,
  MoveDialog,
  NameDialog,
} from "./DashboardDialogs";
import { SceneShareContent } from "./SceneShareContent";
import { Avatar, Button, Dialog, Notice, formatRelative } from "./ui";

import type {
  CollectionInfo,
  SceneSort,
  SceneSummary,
} from "../intranet/workspaceApi";

type View =
  | { kind: "recent" }
  | { kind: "shared" }
  | { kind: "collection"; id: string };

type Modal =
  | { kind: "newCollection" }
  | { kind: "renameCollection"; collection: CollectionInfo }
  | { kind: "deleteCollection"; collection: CollectionInfo }
  | { kind: "collectionAccess"; collection: CollectionInfo }
  | { kind: "renameScene"; scene: SceneSummary }
  | { kind: "moveScene"; scene: SceneSummary }
  | { kind: "shareScene"; scene: SceneSummary }
  | { kind: "deleteScene"; scene: SceneSummary };

const REFRESH_INTERVAL_MS = 30 * 1000;

const readViewFromUrl = (): View => {
  const params = new URLSearchParams(window.location.search);
  const collection = params.get("c");
  if (collection) {
    return { kind: "collection", id: collection };
  }
  return params.get("view") === "shared"
    ? { kind: "shared" }
    : { kind: "recent" };
};

const writeViewToUrl = (view: View) => {
  const params = new URLSearchParams();
  if (view.kind === "collection") {
    params.set("c", view.id);
  } else if (view.kind === "shared") {
    params.set("view", "shared");
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `/?${query}` : "/");
};

const brandMark = (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="3" width="26" height="26" rx="7" fill="currentColor" />
    <path
      d="M9 21c3-6 5.5-9 8-9s2 4 4 4 2.5-2 3-3"
      fill="none"
      stroke="#fff"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
  </svg>
);

const placeholder = (
  <svg viewBox="0 0 120 80" aria-hidden="true" className="ws-card__placeholder">
    <path
      d="M18 58c10-22 22-34 36-30s14 22 30 18 16-20 22-26"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
    <rect
      x="16"
      y="14"
      width="34"
      height="22"
      rx="4"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    />
  </svg>
);

const SceneCard = ({
  scene,
  showCollection,
  onAction,
}: {
  scene: SceneSummary;
  showCollection: boolean;
  onAction: (kind: Modal["kind"], scene: SceneSummary) => void;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const canEdit = scene.role === "editor";

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const act = (kind: Modal["kind"]) => {
    setMenuOpen(false);
    onAction(kind, scene);
  };

  return (
    <article className="ws-card">
      <a className="ws-card__thumb" href={scenePath(scene.id)} tabIndex={-1}>
        {scene.thumbnailUrl ? (
          <img src={scene.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          placeholder
        )}
      </a>
      {scene.activeUsers.length > 0 && (
        <div
          className="ws-card__live"
          title={`Gerade aktiv: ${scene.activeUsers
            .map((u) => u.name)
            .join(", ")}`}
        >
          <span className="ws-live-dot" />
          {scene.activeUsers.slice(0, 3).map((user) => (
            <Avatar key={user.id} id={user.id} name={user.name} />
          ))}
          {scene.activeUsers.length > 3 && (
            <span className="ws-card__live-more">
              +{scene.activeUsers.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="ws-card__body">
        <a className="ws-card__name" href={scenePath(scene.id)}>
          {scene.name}
        </a>
        <div className="ws-card__meta">
          Geändert {formatRelative(scene.updatedAt)}
          {scene.updatedBy ? ` von ${scene.updatedBy}` : ""}
        </div>
        <div className="ws-card__tags">
          {showCollection && scene.collection && (
            <span className="ws-tag">{scene.collection.name}</span>
          )}
          {scene.role === "viewer" && (
            <span className="ws-tag">Nur Ansicht</span>
          )}
          {scene.hasReadLink && <span className="ws-tag">Link aktiv</span>}
        </div>
      </div>
      <div className="ws-card__menu" ref={menuRef}>
        <button
          type="button"
          className="ws-icon-button"
          aria-label={`Aktionen für ${scene.name}`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
        {menuOpen && (
          <ul className="ws-menu" role="menu">
            <li>
              <a
                role="menuitem"
                href={scenePath(scene.id)}
                target="_blank"
                rel="noopener"
              >
                In neuem Tab öffnen
              </a>
            </li>
            {canEdit && (
              <li>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => act("renameScene")}
                >
                  Umbenennen
                </button>
              </li>
            )}
            <li>
              <button
                role="menuitem"
                type="button"
                onClick={() => act("shareScene")}
              >
                {scene.canManage ? "Teilen …" : "Zugriff anzeigen …"}
              </button>
            </li>
            {scene.canManage && (
              <>
                <li>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => act("moveScene")}
                  >
                    Verschieben …
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    type="button"
                    className="ws-menu__danger"
                    onClick={() => act("deleteScene")}
                  >
                    Löschen
                  </button>
                </li>
              </>
            )}
          </ul>
        )}
      </div>
    </article>
  );
};

export const Dashboard = () => {
  const user = getCurrentUser();
  const [view, setView] = useState<View>(readViewFromUrl);
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SceneSort>("updated");
  const [modal, setModal] = useState<Modal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Übersicht · Excalidraw";
  }, []);

  const personal = collections?.find((c) => c.kind === "personal") || null;
  const teamCollections = useMemo(
    () => (collections || []).filter((c) => c.kind === "team"),
    [collections],
  );
  const currentCollection =
    view.kind === "collection"
      ? collections?.find((c) => c.id === view.id) || null
      : null;

  const loadCollections = useCallback(async () => {
    try {
      const { collections } = await workspaceApi.overview();
      setCollections(collections);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const loadScenes = useCallback(async () => {
    try {
      const query =
        view.kind === "collection"
          ? { collection: view.id, q: search, sort }
          : view.kind === "shared"
          ? { view: "shared" as const, q: search, sort }
          : { view: "recent" as const, q: search };
      const { scenes } = await workspaceApi.listScenes(query);
      setScenes(scenes);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setScenes([]);
    }
  }, [view, search, sort]);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    const timer = window.setTimeout(loadScenes, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadScenes, search]);

  // keep "who is drawing right now" and new scenes of colleagues fresh
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        loadScenes();
      }
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadScenes]);

  const navigate = (next: View) => {
    setView(next);
    setScenes(null);
    writeViewToUrl(next);
  };

  const targetCollectionId = () =>
    currentCollection &&
    (currentCollection.role === "editor" ||
      currentCollection.role === "manager")
      ? currentCollection.id
      : personal?.id;

  const createScene = async () => {
    setBusy(true);
    try {
      const { scene } = await workspaceApi.createScene({
        collectionId: targetCollectionId(),
      });
      window.location.assign(scenePath(scene.id));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const [{ loadFromBlob }, { createSceneFromDrawing }] = await Promise.all([
        import("@excalidraw/excalidraw/data/blob"),
        import("../intranet/workspaceScene"),
      ]);
      const data = await loadFromBlob(file, null, null);
      const scene = await createSceneFromDrawing({
        name:
          file.name.replace(/\.(excalidraw|json|png|svg)$/i, "") || "Import",
        collectionId: targetCollectionId(),
        elements: data.elements,
        files: data.files,
      });
      window.location.assign(scenePath(scene.id));
    } catch (err: any) {
      setError(`Import fehlgeschlagen: ${err.message}`);
      setBusy(false);
    }
  };

  const refreshAll = () => {
    loadCollections();
    loadScenes();
  };

  const title =
    view.kind === "recent"
      ? "Zuletzt geöffnet"
      : view.kind === "shared"
      ? "Mit mir geteilt"
      : currentCollection?.name || "Collection";

  const subtitle =
    view.kind === "recent"
      ? "Szenen, die du zuletzt geöffnet oder angelegt hast."
      : view.kind === "shared"
      ? "Szenen, die andere direkt mit dir oder deiner Gruppe geteilt haben."
      : currentCollection?.kind === "personal"
      ? "Nur für dich, außer du teilst einzelne Szenen."
      : "Alle mit Zugriff auf die Collection sehen diese Szenen.";

  const canCreateHere =
    view.kind !== "collection" ||
    currentCollection?.role === "editor" ||
    currentCollection?.role === "manager";

  return (
    <div className="ws-theme ws-dashboard">
      <header className="ws-header">
        <a className="ws-brand" href="/">
          <span className="ws-brand__logo">{brandMark}</span>
          Excalidraw
        </a>
        <div className="ws-header__search">
          <input
            className="ws-input"
            type="search"
            placeholder="Szenen suchen …"
            aria-label="Szenen suchen"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="ws-header__right">
          <a className="ws-link" href={LOCAL_EDITOR_PATH}>
            Lokale Zeichnung
          </a>
          {user && (
            <span className="ws-user" title={user.email || user.name}>
              <Avatar id={user.id} name={user.name} />
              <span className="ws-user__name">{user.name}</span>
            </span>
          )}
          <Button variant="ghost" onClick={() => logout()}>
            Abmelden
          </Button>
        </div>
      </header>

      <div className="ws-layout">
        <nav className="ws-sidebar" aria-label="Bereiche">
          <button
            type="button"
            className={clsx(
              "ws-nav-item",
              view.kind === "recent" && "is-active",
            )}
            onClick={() => navigate({ kind: "recent" })}
          >
            Zuletzt geöffnet
          </button>
          {personal && (
            <button
              type="button"
              className={clsx(
                "ws-nav-item",
                view.kind === "collection" &&
                  view.id === personal.id &&
                  "is-active",
              )}
              onClick={() => navigate({ kind: "collection", id: personal.id })}
            >
              Meine Szenen
              <span className="ws-nav-item__count">{personal.sceneCount}</span>
            </button>
          )}
          <button
            type="button"
            className={clsx(
              "ws-nav-item",
              view.kind === "shared" && "is-active",
            )}
            onClick={() => navigate({ kind: "shared" })}
          >
            Mit mir geteilt
          </button>

          <div className="ws-sidebar__heading">
            <span>Collections</span>
            <button
              type="button"
              className="ws-icon-button"
              aria-label="Neue Collection"
              title="Neue Collection"
              onClick={() => setModal({ kind: "newCollection" })}
            >
              +
            </button>
          </div>
          {teamCollections.length === 0 && (
            <p className="ws-sidebar__empty">
              Noch keine. Collections teilen Szenen mit Teams.
            </p>
          )}
          {teamCollections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={clsx(
                "ws-nav-item",
                view.kind === "collection" &&
                  view.id === collection.id &&
                  "is-active",
              )}
              onClick={() =>
                navigate({ kind: "collection", id: collection.id })
              }
            >
              <span className="ws-nav-item__label">{collection.name}</span>
              <span className="ws-nav-item__count">
                {collection.sceneCount}
              </span>
            </button>
          ))}
        </nav>

        <main className="ws-main">
          <div className="ws-main__header">
            <div>
              <h1>{title}</h1>
              <p className="ws-muted">{subtitle}</p>
            </div>
            <div className="ws-main__actions">
              {currentCollection?.kind === "team" && (
                <>
                  <Button
                    onClick={() =>
                      setModal({
                        kind: "collectionAccess",
                        collection: currentCollection,
                      })
                    }
                  >
                    {currentCollection.role === "manager"
                      ? "Zugriff verwalten"
                      : "Zugriff anzeigen"}
                  </Button>
                  {currentCollection.role === "manager" && (
                    <>
                      <Button
                        onClick={() =>
                          setModal({
                            kind: "renameCollection",
                            collection: currentCollection,
                          })
                        }
                      >
                        Umbenennen
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setModal({
                            kind: "deleteCollection",
                            collection: currentCollection,
                          })
                        }
                      >
                        Löschen
                      </Button>
                    </>
                  )}
                </>
              )}
              {view.kind !== "recent" && (
                <select
                  className="ws-input ws-sort"
                  aria-label="Sortierung"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SceneSort)}
                >
                  <option value="updated">Zuletzt geändert</option>
                  <option value="created">Zuletzt angelegt</option>
                  <option value="name">Name</option>
                </select>
              )}
              {canCreateHere && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Importieren
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={createScene}
                  >
                    Neue Szene
                  </Button>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".excalidraw,.json,.png,.svg,application/vnd.excalidraw+json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    importFile(file);
                  }
                }}
              />
            </div>
          </div>

          {error && <Notice kind="error">{error}</Notice>}

          {scenes === null ? (
            <p className="ws-muted">Lade …</p>
          ) : scenes.length === 0 ? (
            <div className="ws-empty">
              <h2>
                {search
                  ? "Keine Szene gefunden"
                  : view.kind === "shared"
                  ? "Noch nichts geteilt"
                  : "Noch keine Szenen"}
              </h2>
              <p className="ws-muted">
                {search
                  ? "Versuche einen anderen Suchbegriff."
                  : view.kind === "shared"
                  ? "Wenn jemand eine Szene mit dir teilt, erscheint sie hier."
                  : "Lege eine neue Szene an oder importiere eine .excalidraw-Datei."}
              </p>
              {canCreateHere && view.kind !== "shared" && !search && (
                <Button variant="primary" disabled={busy} onClick={createScene}>
                  Neue Szene
                </Button>
              )}
            </div>
          ) : (
            <section className="ws-grid" aria-label={title}>
              {scenes.map((scene) => (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  showCollection={view.kind !== "collection"}
                  onAction={(kind, target) =>
                    setModal({ kind, scene: target } as Modal)
                  }
                />
              ))}
            </section>
          )}
        </main>
      </div>

      {modal?.kind === "newCollection" && (
        <NameDialog
          title="Neue Collection"
          label="Name"
          submitLabel="Anlegen"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const created = await workspaceApi.createCollection(name);
            await loadCollections();
            navigate({ kind: "collection", id: created.id });
          }}
        />
      )}
      {modal?.kind === "renameCollection" && (
        <NameDialog
          title="Collection umbenennen"
          label="Name"
          initial={modal.collection.name}
          submitLabel="Umbenennen"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await workspaceApi.renameCollection(modal.collection.id, name);
            refreshAll();
          }}
        />
      )}
      {modal?.kind === "deleteCollection" && (
        <ConfirmDialog
          title="Collection löschen"
          text={`„${modal.collection.name}“ wird gelöscht. Das geht nur, wenn sie keine Szenen mehr enthält.`}
          confirmLabel="Löschen"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await workspaceApi.deleteCollection(modal.collection.id);
            await loadCollections();
            navigate({ kind: "recent" });
          }}
        />
      )}
      {modal?.kind === "collectionAccess" && (
        <CollectionAccessDialog
          collection={modal.collection}
          onClose={() => {
            setModal(null);
            refreshAll();
          }}
        />
      )}
      {modal?.kind === "renameScene" && (
        <NameDialog
          title="Szene umbenennen"
          label="Name"
          initial={modal.scene.name}
          submitLabel="Umbenennen"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await workspaceApi.updateScene(modal.scene.id, { name });
            loadScenes();
          }}
        />
      )}
      {modal?.kind === "moveScene" && collections && (
        <MoveDialog
          scene={modal.scene}
          collections={collections}
          onClose={() => setModal(null)}
          onMoved={refreshAll}
        />
      )}
      {modal?.kind === "shareScene" && (
        <Dialog
          title={`„${modal.scene.name}“ teilen`}
          onClose={() => setModal(null)}
        >
          <SceneShareContent
            scene={modal.scene}
            onDone={() => {
              setModal(null);
              loadScenes();
            }}
          />
        </Dialog>
      )}
      {modal?.kind === "deleteScene" && (
        <ConfirmDialog
          title="Szene löschen"
          text={`„${modal.scene.name}“ wird für alle gelöscht, die Zugriff haben.`}
          confirmLabel="Löschen"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await workspaceApi.deleteScene(modal.scene.id);
            refreshAll();
          }}
        />
      )}
    </div>
  );
};
