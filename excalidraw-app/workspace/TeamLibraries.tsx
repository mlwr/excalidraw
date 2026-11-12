/**
 * Intranet fork: team and company libraries (L2) in their own sidebar tab.
 * Items are dragged onto the canvas or inserted with a click; whoever
 * maintains a library adds the current selection or removes items.
 */
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { exportScene, serializeLibraryAsJSON } from "@excalidraw/excalidraw";
import { useApp } from "@excalidraw/excalidraw/components/App";
import { distributeLibraryItemsOnSquareGrid } from "@excalidraw/excalidraw/data/library";
import { MIME_TYPES, randomId } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";

import type {
  ExcalidrawImperativeAPI,
  LibraryItem,
  LibraryItems,
} from "@excalidraw/excalidraw/types";

import { BackendError } from "../intranet/api";
import { libraryApi } from "../intranet/libraryApi";

import { NameDialog } from "./DashboardDialogs";
import { Button, Notice } from "./ui";

import type { LibraryList, SharedLibraryInfo } from "../intranet/libraryApi";

export const TEAM_LIBRARY_TAB = "team-libraries";

const scopeLabel = (library: SharedLibraryInfo) =>
  library.kind === "workspace"
    ? `Workspace „${library.scope?.name ?? "?"}“`
    : `Collection „${library.scope?.name ?? "?"}“`;

const ItemPreview = ({ item }: { item: LibraryItem }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    exportScene({
      type: "svg",
      data: { elements: getNonDeletedElements(item.elements), files: null },
      config: { padding: 8, skipInliningFonts: true },
    })
      .then((svg) => {
        if (!cancelled && ref.current) {
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          ref.current.replaceChildren(svg);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [item]);
  return <div ref={ref} className="ws-teamlib__preview" aria-hidden="true" />;
};

/** the selected elements with their labels and frame contents */
const selectionOf = (api: ExcalidrawImperativeAPI) => {
  const selected = api.getAppState().selectedElementIds;
  const elements = api.getSceneElements();
  const ids = new Set(Object.keys(selected).filter((id) => selected[id]));
  return elements.filter(
    (element) =>
      ids.has(element.id) ||
      (element.type === "text" &&
        element.containerId &&
        ids.has(element.containerId)) ||
      (element.frameId && ids.has(element.frameId)),
  );
};

export const TeamLibrariesTab = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const app = useApp();
  const [list, setList] = useState<LibraryList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    items: LibraryItems;
    revision: number;
  } | null>(null);
  const items = loaded?.items ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const shared = (list?.libraries || []).filter(
    (library) => library.kind !== "personal",
  );
  const library = shared.find((item) => item.id === selectedId) || null;

  const loadList = useCallback(async () => {
    try {
      const result = await libraryApi.list();
      setList(result);
      setSelectedId((current) => {
        const ids = result.libraries
          .filter((item) => item.kind !== "personal")
          .map((item) => item.id);
        return current && ids.includes(current) ? current : ids[0] || null;
      });
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setLoaded(null);
    libraryApi
      .get(selectedId)
      .then(
        (result) =>
          !cancelled &&
          setLoaded({
            items: result.libraryItems,
            revision: result.library.revision,
          }),
      )
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  /**
   * Apply a change and save it. If someone else saved in between, their
   * version is loaded and the change applied to it again: nobody's items
   * get lost.
   */
  const change = async (apply: (current: LibraryItems) => LibraryItems) => {
    if (!library || !loaded) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let base = loaded;
      for (let attempt = 1; ; attempt++) {
        const next = apply(base.items);
        try {
          const { revision } = await libraryApi.save(
            library.id,
            next,
            base.revision,
          );
          setLoaded({ items: next, revision });
          break;
        } catch (err) {
          if (
            !(err instanceof BackendError && err.status === 409) ||
            attempt >= 3
          ) {
            throw err;
          }
          const fresh = await libraryApi.get(library.id);
          base = {
            items: fresh.libraryItems,
            revision: fresh.library.revision,
          };
        }
      }
      loadList();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const addSelection = () => {
    if (!excalidrawAPI || !items) {
      return;
    }
    const elements = selectionOf(excalidrawAPI);
    if (!elements.length) {
      setError("Erst Elemente auf der Zeichenfläche auswählen.");
      return;
    }
    const added: LibraryItem = {
      id: randomId(),
      status: "published",
      created: Date.now(),
      elements: JSON.parse(JSON.stringify(elements)),
    };
    change((current) => [added, ...current]);
  };

  const insert = (item: LibraryItem) => {
    app.onInsertElements(distributeLibraryItemsOnSquareGrid([item]));
    app.focusContainer();
  };

  const creatable = [
    ...(list?.canCreate.workspaces || []).map((scope) => ({
      key: `w:${scope.id}`,
      label: `Workspace „${scope.name}“`,
      scope: { workspaceId: scope.id },
    })),
    ...(list?.canCreate.collections || []).map((scope) => ({
      key: `c:${scope.id}`,
      label: `Collection „${scope.name}“`,
      scope: { collectionId: scope.id },
    })),
  ];
  const [createScope, setCreateScope] = useState<string>("");

  return (
    <div className="ws-theme ws-teamlib">
      {list === null ? (
        <p className="ws-muted">Lade …</p>
      ) : (
        <>
          <div className="ws-teamlib__head">
            {shared.length > 0 ? (
              <select
                className="ws-input"
                aria-label="Bibliothek"
                value={selectedId || ""}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {shared.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.items})
                  </option>
                ))}
              </select>
            ) : (
              <p className="ws-muted">
                Noch keine Team- oder Firmenbibliothek. Team-Bibliotheken legen
                Personen an, die eine Team-Collection bearbeiten dürfen;
                Firmenbibliotheken die Admins eines Workspaces.
              </p>
            )}
            {creatable.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  setCreateScope(creatable[0].key);
                  setCreating(true);
                }}
              >
                Neue Bibliothek
              </Button>
            )}
          </div>
          {library && (
            <p className="ws-muted ws-teamlib__scope">
              {scopeLabel(library)}
              {library.canEdit ? " · du pflegst sie" : ""}
            </p>
          )}
          {error && <Notice kind="error">{error}</Notice>}
          {library?.canEdit && (
            <Button disabled={busy || !items} onClick={addSelection}>
              Auswahl hinzufügen
            </Button>
          )}
          {library && items === null && <p className="ws-muted">Lade …</p>}
          {library && items?.length === 0 && (
            <p className="ws-muted">
              Leer.{" "}
              {library.canEdit
                ? "Elemente auswählen und „Auswahl hinzufügen“."
                : ""}
            </p>
          )}
          {items && items.length > 0 && (
            <ul className="ws-teamlib__grid" aria-label="Einträge">
              {items.map((item) => (
                <li key={item.id} className={clsx("ws-teamlib__item")}>
                  <button
                    type="button"
                    className="ws-teamlib__insert"
                    title={
                      item.name
                        ? `${item.name}: einfügen oder auf die Zeichenfläche ziehen`
                        : "Einfügen oder auf die Zeichenfläche ziehen"
                    }
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        MIME_TYPES.excalidrawlib,
                        serializeLibraryAsJSON([item]),
                      );
                    }}
                    onClick={() => insert(item)}
                  >
                    <ItemPreview item={item} />
                  </button>
                  {library?.canEdit && (
                    <button
                      type="button"
                      className="ws-teamlib__remove"
                      aria-label="Aus der Bibliothek entfernen"
                      disabled={busy}
                      onClick={() =>
                        change((current) =>
                          current.filter((other) => other.id !== item.id),
                        )
                      }
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {creating && (
        <NameDialog
          title="Neue Bibliothek"
          label="Name"
          submitLabel="Anlegen"
          extra={
            creatable.length > 1 ? (
              <label className="ws-field">
                <span>Für</span>
                <select
                  className="ws-input"
                  value={createScope}
                  onChange={(event) => setCreateScope(event.target.value)}
                >
                  {creatable.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="ws-muted">Für {creatable[0]?.label}</p>
            )
          }
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const option =
              creatable.find((item) => item.key === createScope) ||
              creatable[0];
            const { library: created } = await libraryApi.create(
              name,
              option.scope,
            );
            await loadList();
            setSelectedId(created.id);
          }}
        />
      )}
    </div>
  );
};
