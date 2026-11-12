import clsx from "clsx";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { logoUrl, useBranding } from "../intranet/branding";
import { ADMIN_PATH, LOCAL_EDITOR_PATH, scenePath } from "../intranet/routes";
import { getCurrentUser, getRuntimeConfig, logout } from "../intranet/session";
import { workspaceApi } from "../intranet/workspaceApi";

import { ActivityFeed } from "./ActivityFeed";
import { ApiTokensDialog } from "./ApiTokensDialog";
import {
  CollectionAccessDialog,
  ConfirmDialog,
  MoveDialog,
  NameDialog,
} from "./DashboardDialogs";
import { SceneShareContent } from "./SceneShareContent";
import { TrashView } from "./TrashView";
import { Avatar, Button, Dialog, Notice, formatRelative } from "./ui";

import type {
  CollectionInfo,
  SceneSort,
  SceneSummary,
  SearchResult,
  WorkspaceOverview,
} from "../intranet/workspaceApi";

type View =
  | { kind: "recent" }
  | { kind: "shared" }
  | { kind: "activity" }
  | { kind: "trash" }
  | { kind: "collection"; id: string };

const LIST_VIEWS = ["shared", "activity", "trash"] as const;
const MIN_SEARCH = 2;

type Modal =
  | { kind: "newCollection" }
  | { kind: "renameCollection"; collection: CollectionInfo }
  | { kind: "deleteCollection"; collection: CollectionInfo }
  | { kind: "collectionAccess"; collection: CollectionInfo }
  | { kind: "renameScene"; scene: SceneSummary }
  | { kind: "moveScene"; scene: SceneSummary }
  | { kind: "shareScene"; scene: SceneSummary }
  | { kind: "deleteScene"; scene: SceneSummary }
  | { kind: "apiTokens" };

const REFRESH_INTERVAL_MS = 30 * 1000;

const readViewFromUrl = (): View => {
  const params = new URLSearchParams(window.location.search);
  const collection = params.get("c");
  if (collection) {
    return { kind: "collection", id: collection };
  }
  const view = params.get("view");
  const known = LIST_VIEWS.find((kind) => kind === view);
  return known ? { kind: known } : { kind: "recent" };
};

/** "" = the default workspace */
const readWorkspaceFromUrl = () =>
  new URLSearchParams(window.location.search).get("w") || "";

const writeViewToUrl = (view: View, workspace: string) => {
  const params = new URLSearchParams();
  if (workspace && workspace !== "default") {
    params.set("w", workspace);
  }
  if (view.kind === "collection") {
    params.set("c", view.id);
  } else if (view.kind !== "recent") {
    params.set("view", view.kind);
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
  snippet,
}: {
  scene: SceneSummary;
  showCollection: boolean;
  onAction: (kind: Modal["kind"], scene: SceneSummary) => void;
  snippet?: SearchResult["snippet"];
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
        {snippet && (
          <p className="ws-card__snippet">
            <span className="ws-card__snippet-kind">
              {snippet.kind === "comment" ? "Kommentar" : "Text"}
            </span>
            {snippet.text}
          </p>
        )}
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
  const branding = useBranding();
  const [workspaceSlug, setWorkspaceSlug] = useState(readWorkspaceFromUrl);
  const [view, setView] = useState<View>(readViewFromUrl);
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SceneSort>("updated");
  const [modal, setModal] = useState<Modal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const collections = overview?.collections || null;
  const workspace = overview?.workspace || null;
  // "default" is the slug of the default workspace
  const slug = workspaceSlug || "default";
  const searching = search.trim().length >= MIN_SEARCH;

  useEffect(() => {
    document.title = `Übersicht · ${branding.name}`;
  }, [branding.name]);

  const personal = collections?.find((c) => c.kind === "personal") || null;
  const teamCollections = useMemo(
    () => (collections || []).filter((c) => c.kind === "team"),
    [collections],
  );
  const currentCollection =
    view.kind === "collection"
      ? collections?.find((c) => c.id === view.id) || null
      : null;

  const isWorkspaceAdmin = workspace?.access === "admin";
  const isMember = workspace?.access === "member" || isWorkspaceAdmin;
  const policies = workspace?.policies;
  const canCreateCollection =
    isMember && (policies?.collectionCreation !== "admins" || isWorkspaceAdmin);
  const canExport = !!workspace && (policies?.export || isWorkspaceAdmin);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await workspaceApi.overview(workspaceSlug || undefined));
    } catch (err: any) {
      setError(err.message);
    }
  }, [workspaceSlug]);

  // only the newest request may show its answer (a slow older one would
  // overwrite newer results)
  const scenesRequest = useRef(0);
  const searchRequest = useRef(0);

  const loadScenes = useCallback(async () => {
    const request = ++scenesRequest.current;
    if (view.kind === "activity" || view.kind === "trash") {
      return;
    }
    try {
      const query =
        view.kind === "collection"
          ? { collection: view.id, sort }
          : view.kind === "shared"
          ? { view: "shared" as const, sort, workspace: slug }
          : { view: "recent" as const, workspace: slug };
      const { scenes } = await workspaceApi.listScenes(query);
      if (request === scenesRequest.current) {
        setScenes(scenes);
        setError(null);
      }
    } catch (err: any) {
      if (request === scenesRequest.current) {
        setError(err.message);
        setScenes([]);
      }
    }
  }, [view, sort, slug]);

  const runSearch = useCallback(async () => {
    const request = ++searchRequest.current;
    if (!searching) {
      setResults(null);
      return;
    }
    try {
      const { results } = await workspaceApi.search(slug, search.trim());
      if (request === searchRequest.current) {
        setResults(results);
        setError(null);
      }
    } catch (err: any) {
      if (request === searchRequest.current) {
        setError(err.message);
        setResults([]);
      }
    }
  }, [searching, search, slug]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadScenes();
  }, [loadScenes]);

  useEffect(() => {
    const timer = window.setTimeout(runSearch, 250);
    return () => window.clearTimeout(timer);
  }, [runSearch]);

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
    setSearch("");
    writeViewToUrl(next, slug);
  };

  const switchWorkspace = (next: string) => {
    const home: View = { kind: "recent" };
    setWorkspaceSlug(next);
    setOverview(null);
    setView(home);
    setScenes(null);
    setSearch("");
    writeViewToUrl(home, next);
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
        workspaceId: workspace?.id,
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
    loadOverview();
    loadScenes();
  };

  const title = searching
    ? "Suchergebnisse"
    : view.kind === "recent"
    ? "Zuletzt geöffnet"
    : view.kind === "shared"
    ? "Mit mir geteilt"
    : view.kind === "activity"
    ? "Aktivität"
    : view.kind === "trash"
    ? "Papierkorb"
    : currentCollection?.name || "Collection";

  const subtitle = searching
    ? `Namen, Texte in Zeichnungen und Kommentare in „${
        workspace?.name || "Workspace"
      }“, soweit du sie sehen darfst.`
    : view.kind === "recent"
    ? "Szenen, die du zuletzt geöffnet oder angelegt hast."
    : view.kind === "shared"
    ? "Szenen, die andere direkt mit dir oder deiner Gruppe geteilt haben."
    : view.kind === "activity"
    ? "Was in Szenen und Collections passiert ist, die du sehen kannst."
    : view.kind === "trash"
    ? `Gelöschte Szenen bleiben ${
        policies?.trashRetentionDays ?? 30
      } Tage hier, dann werden sie endgültig gelöscht.`
    : currentCollection?.kind === "personal"
    ? "Nur für dich, außer du teilst einzelne Szenen."
    : "Alle mit Zugriff auf die Collection sehen diese Szenen.";

  const isSceneList =
    !searching && view.kind !== "activity" && view.kind !== "trash";
  const canCreateHere =
    isSceneList &&
    (view.kind === "collection"
      ? currentCollection?.role === "editor" ||
        currentCollection?.role === "manager"
      : !!personal);
  const logo = logoUrl(branding);
  const showAdmin = !!user?.isAdmin || isWorkspaceAdmin;

  const navItem = (target: View, label: string, count?: number) => (
    <button
      type="button"
      className={clsx(
        "ws-nav-item",
        !searching &&
          view.kind === target.kind &&
          (target.kind !== "collection" ||
            (view.kind === "collection" && view.id === target.id)) &&
          "is-active",
      )}
      onClick={() => navigate(target)}
    >
      <span className="ws-nav-item__label">{label}</span>
      {count !== undefined && (
        <span className="ws-nav-item__count">{count}</span>
      )}
    </button>
  );

  return (
    <div className="ws-theme ws-dashboard">
      <header className="ws-header">
        <a className="ws-brand" href="/">
          <span className="ws-brand__logo">
            {logo ? <img src={logo} alt="" /> : brandMark}
          </span>
          {branding.name}
        </a>
        <div className="ws-header__search">
          <input
            className="ws-input"
            type="search"
            placeholder={`In „${workspace?.name || "Workspace"}“ suchen …`}
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
          {getRuntimeConfig().api.enabled && (
            <Button
              variant="ghost"
              onClick={() => setModal({ kind: "apiTokens" })}
            >
              API-Tokens
            </Button>
          )}
          <Button variant="ghost" onClick={() => logout()}>
            Abmelden
          </Button>
        </div>
      </header>

      <div className="ws-layout">
        <nav className="ws-sidebar" aria-label="Bereiche">
          {overview && overview.workspaces.length > 1 && (
            <label className="ws-workspace-switch">
              <span className="ws-visually-hidden">Workspace</span>
              <select
                className="ws-input"
                aria-label="Workspace"
                value={slug}
                onChange={(event) => switchWorkspace(event.target.value)}
              >
                {overview.workspaces.map((item) => (
                  <option key={item.id} value={item.slug}>
                    {item.name}
                    {item.access === "guest" ? " (geteilt)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {navItem({ kind: "recent" }, "Zuletzt geöffnet")}
          {personal &&
            navItem(
              { kind: "collection", id: personal.id },
              "Meine Szenen",
              personal.sceneCount,
            )}
          {navItem({ kind: "shared" }, "Mit mir geteilt")}
          {navItem({ kind: "activity" }, "Aktivität")}

          <div className="ws-sidebar__heading">
            <span>Collections</span>
            {canCreateCollection && (
              <button
                type="button"
                className="ws-icon-button"
                aria-label="Neue Collection"
                title="Neue Collection"
                onClick={() => setModal({ kind: "newCollection" })}
              >
                +
              </button>
            )}
          </div>
          {teamCollections.length === 0 && (
            <p className="ws-sidebar__empty">
              Noch keine. Collections teilen Szenen mit Teams.
            </p>
          )}
          {teamCollections.map((collection) => (
            <Fragment key={collection.id}>
              {navItem(
                { kind: "collection", id: collection.id },
                collection.name,
                collection.sceneCount,
              )}
            </Fragment>
          ))}

          <div className="ws-sidebar__footer">
            {navItem({ kind: "trash" }, "Papierkorb")}
            {canExport && (
              <a
                className="ws-nav-item"
                href={workspaceApi.exportUrl(slug)}
                download
                title="Alle Szenen, die du hier sehen kannst, als ZIP mit .excalidraw-Dateien"
              >
                <span className="ws-nav-item__label">Alles exportieren</span>
              </a>
            )}
            {showAdmin && (
              <a className="ws-nav-item" href={ADMIN_PATH}>
                <span className="ws-nav-item__label">Verwaltung</span>
              </a>
            )}
            {branding.links.length > 0 && (
              <ul className="ws-sidebar__links">
                {branding.links.map((link) => (
                  <li key={link.url}>
                    <a
                      className="ws-link"
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </nav>

        <main className="ws-main">
          <div className="ws-main__header">
            <div>
              <h1>{title}</h1>
              <p className="ws-muted">{subtitle}</p>
            </div>
            <div className="ws-main__actions">
              {searching && (
                <Button variant="ghost" onClick={() => setSearch("")}>
                  Suche zurücksetzen
                </Button>
              )}
              {isSceneList && currentCollection?.kind === "team" && (
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
              {isSceneList && currentCollection && canExport && (
                <a
                  className="ws-button ws-button--ghost"
                  href={workspaceApi.exportUrl(slug, currentCollection.id)}
                  download
                >
                  Exportieren
                </a>
              )}
              {isSceneList && view.kind !== "recent" && (
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

          {searching ? (
            results === null ? (
              <p className="ws-muted">Suche …</p>
            ) : results.length === 0 ? (
              <div className="ws-empty">
                <h2>Nichts gefunden</h2>
                <p className="ws-muted">
                  Gesucht wird nach Wortanfängen, z. B. findet „Urlaub“ auch
                  „Urlaubsantrag“. Alle Wörter müssen vorkommen.
                </p>
              </div>
            ) : (
              <section className="ws-grid" aria-label="Suchergebnisse">
                {results.map((scene) => (
                  <SceneCard
                    key={scene.id}
                    scene={scene}
                    showCollection
                    snippet={scene.snippet}
                    onAction={(kind, target) =>
                      setModal({ kind, scene: target } as Modal)
                    }
                  />
                ))}
              </section>
            )
          ) : view.kind === "activity" ? (
            <ActivityFeed workspace={slug} />
          ) : view.kind === "trash" ? (
            <TrashView
              workspace={slug}
              retentionDays={policies?.trashRetentionDays ?? 30}
              onChanged={refreshAll}
            />
          ) : scenes === null ? (
            <p className="ws-muted">Lade …</p>
          ) : scenes.length === 0 ? (
            <div className="ws-empty">
              <h2>
                {view.kind === "shared"
                  ? "Noch nichts geteilt"
                  : "Noch keine Szenen"}
              </h2>
              <p className="ws-muted">
                {view.kind === "shared"
                  ? "Wenn jemand eine Szene mit dir teilt, erscheint sie hier."
                  : "Lege eine neue Szene an oder importiere eine .excalidraw-Datei."}
              </p>
              {canCreateHere && view.kind !== "shared" && (
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
            const created = await workspaceApi.createCollection(
              name,
              workspace?.id,
            );
            await loadOverview();
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
            await loadOverview();
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
            runSearch();
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
          text={`„${
            modal.scene.name
          }“ kommt in den Papierkorb und ist für alle mit Zugriff weg. ${
            policies?.trashRetentionDays ?? 30
          } Tage lang lässt sie sich dort wiederherstellen.`}
          confirmLabel="In den Papierkorb"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await workspaceApi.deleteScene(modal.scene.id);
            refreshAll();
            runSearch();
          }}
        />
      )}
      {modal?.kind === "apiTokens" && (
        <ApiTokensDialog onClose={() => setModal(null)} />
      )}
    </div>
  );
};
