/**
 * Intranet fork: version history of a workspace scene (W7). The server
 * keeps earlier states (at most one per interval, thinned out over time);
 * they are encrypted with the scene key like the scene itself. Everyone who
 * can open the scene can look at them; editors can restore one, which
 * replaces the drawing for everyone (and keeps the replaced state).
 */
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { exportScene, restoreElements } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { atom, useAtom } from "../app-jotai";
import { fromBase64 } from "../intranet/api";
import { workspaceApi } from "../intranet/workspaceApi";

import { Button, Dialog, Notice, formatRelative } from "./ui";

import type { ActiveScene } from "../intranet/activeScene";
import type { VersionInfo } from "../intranet/workspaceApi";

export const versionsOpenAtom = atom(false);

const dateTime = new Intl.DateTimeFormat("de", {
  dateStyle: "medium",
  timeStyle: "short",
});

const REASONS: Record<VersionInfo["reason"], string> = {
  auto: "",
  restore: "vor einer Wiederherstellung",
  import: "vor einem Import",
};

type Selected = "current" | string;

const decryptVersion = async (
  sceneId: string,
  versionId: string,
  key: string,
): Promise<ExcalidrawElement[]> => {
  const version = await workspaceApi.version(sceneId, versionId);
  const decrypted = await decryptData(
    fromBase64(version.iv),
    fromBase64(version.ciphertext),
    key,
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
};

const Preview = ({
  elements,
  api,
}: {
  elements: readonly ExcalidrawElement[] | null;
  api: ExcalidrawImperativeAPI;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const container = ref.current;
    if (!container || !elements) {
      return;
    }
    let cancelled = false;
    const visible = getNonDeletedElements(restoreElements(elements, null));
    setEmpty(!visible.length);
    if (!visible.length) {
      container.replaceChildren();
      return;
    }
    exportScene({
      type: "svg",
      data: {
        elements: visible,
        appState: {
          viewBackgroundColor: api.getAppState().viewBackgroundColor,
        },
        // images are stored by content: the current ones cover most versions
        files: api.getFiles(),
      },
      // shown inside the editor, whose fonts are loaded already (inlining
      // them would subset glyphs with code the CSP does not allow)
      config: { padding: 16, skipInliningFonts: true },
    })
      .then((svg) => {
        if (!cancelled) {
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          container.replaceChildren(svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          container.replaceChildren();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [elements, api]);

  return (
    <div className="ws-versions__preview">
      {elements === null && <p className="ws-muted">Lade Vorschau …</p>}
      {empty && <p className="ws-muted">Diese Version ist leer.</p>}
      <div ref={ref} className="ws-versions__svg" aria-label="Vorschau" />
    </div>
  );
};

export const VersionsDialog = ({
  scene,
  excalidrawAPI,
}: {
  scene: ActiveScene;
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const [open, setOpen] = useAtom(versionsOpenAtom);
  const [data, setData] = useState<Awaited<
    ReturnType<typeof workspaceApi.versions>
  > | null>(null);
  const [selected, setSelected] = useState<Selected>("current");
  const [elements, setElements] = useState<readonly ExcalidrawElement[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await workspaceApi.versions(scene.id));
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, [scene.id]);

  useEffect(() => {
    if (open) {
      setSelected("current");
      setMessage(null);
      load();
    }
  }, [open, load]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setConfirming(false);
    if (selected === "current") {
      setElements(excalidrawAPI.getSceneElementsIncludingDeleted());
      return;
    }
    let cancelled = false;
    setElements(null);
    decryptVersion(scene.id, selected, scene.key)
      .then((result) => !cancelled && setElements(result))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, selected, scene.id, scene.key, excalidrawAPI]);

  if (!open) {
    return null;
  }

  const close = () => setOpen(false);
  const version = data?.versions.find((item) => item.id === selected);

  const restore = async () => {
    if (!version) {
      return;
    }
    setRestoring(true);
    setError(null);
    try {
      await workspaceApi.restoreVersion(scene.id, version.id);
      // the server sends the restored drawing to every open editor
      setMessage(
        `Der Stand vom ${dateTime.format(
          new Date(version.savedAt),
        )} ist wiederhergestellt. Der vorherige Stand bleibt im Verlauf.`,
      );
      setSelected("current");
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRestoring(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog title="Versionsverlauf" size="wide" onClose={close}>
      <div className="ws-versions">
        <ol className="ws-versions__list" aria-label="Versionen">
          <li>
            <button
              type="button"
              className={clsx(
                "ws-versions__item",
                selected === "current" && "is-active",
              )}
              onClick={() => setSelected("current")}
            >
              <strong>Aktueller Stand</strong>
              {data && (
                <span className="ws-muted">
                  {formatRelative(data.current.savedAt)}
                  {data.current.savedBy ? ` · ${data.current.savedBy}` : ""}
                </span>
              )}
            </button>
          </li>
          {data?.versions.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={clsx(
                  "ws-versions__item",
                  selected === item.id && "is-active",
                )}
                onClick={() => setSelected(item.id)}
              >
                <strong>{dateTime.format(new Date(item.savedAt))}</strong>
                <span className="ws-muted">
                  {item.savedBy || "Unbekannt"}
                  {REASONS[item.reason] ? ` · ${REASONS[item.reason]}` : ""}
                </span>
              </button>
            </li>
          ))}
          {data && data.versions.length === 0 && (
            <li className="ws-muted ws-versions__none">
              Noch keine früheren Versionen. Beim Bearbeiten wird regelmäßig ein
              Stand gesichert.
            </li>
          )}
        </ol>
        <div className="ws-versions__detail">
          {error && <Notice kind="error">{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          <Preview elements={elements} api={excalidrawAPI} />
          {version && data?.canRestore && (
            <div className="ws-versions__actions">
              {confirming ? (
                <>
                  <span>
                    Die Zeichnung wird für alle durch diesen Stand ersetzt.
                  </span>
                  <Button onClick={() => setConfirming(false)}>
                    Abbrechen
                  </Button>
                  <Button
                    variant="primary"
                    disabled={restoring}
                    onClick={restore}
                  >
                    {restoring ? "Stellt wieder her …" : "Ja, wiederherstellen"}
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => setConfirming(true)}>
                  Diese Version wiederherstellen
                </Button>
              )}
            </div>
          )}
          {version && data && !data.canRestore && (
            <p className="ws-muted">
              Wiederherstellen können nur Personen, die die Szene bearbeiten
              dürfen.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
};
