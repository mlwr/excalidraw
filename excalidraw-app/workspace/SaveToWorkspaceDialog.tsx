import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useState } from "react";

import { atom, useAtom } from "../app-jotai";
import { scenePath } from "../intranet/routes";
import { workspaceApi } from "../intranet/workspaceApi";
import { createSceneFromDrawing } from "../intranet/workspaceScene";

import { Button, Dialog, Notice } from "./ui";

import type { CollectionInfo } from "../intranet/workspaceApi";

export const saveToWorkspaceOpenAtom = atom(false);

/** copy the drawing of the local editor into a new workspace scene */
export const SaveToWorkspaceDialog = () => {
  const [open, setOpen] = useAtom(saveToWorkspaceOpenAtom);
  const excalidrawAPI = useExcalidrawAPI();
  const [name, setName] = useState("");
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setName(excalidrawAPI?.getName() || "");
    workspaceApi
      .overview()
      .then(({ collections }) => {
        const writable = collections.filter(
          (collection) =>
            collection.role === "editor" || collection.role === "manager",
        );
        setCollections(writable);
        setCollectionId(
          writable.find((c) => c.kind === "personal")?.id ||
            writable[0]?.id ||
            "",
        );
      })
      .catch((err) => setError(err.message));
  }, [open, excalidrawAPI]);

  if (!open || !excalidrawAPI) {
    return null;
  }

  const close = () => setOpen(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const scene = await createSceneFromDrawing({
        name: name.trim() || "Unbenannte Szene",
        collectionId: collectionId || undefined,
        elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
        files: excalidrawAPI.getFiles(),
      });
      window.location.assign(scenePath(scene.id));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Im Workspace speichern"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Abbrechen</Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? "Speichert …" : "Speichern und öffnen"}
          </Button>
        </>
      }
    >
      <p className="ws-muted">
        Die Zeichnung wird als neue Szene auf dem Server gespeichert. Die lokale
        Zeichnung in diesem Browser bleibt unverändert.
      </p>
      <label className="ws-field">
        <span>Name</span>
        <input
          className="ws-input"
          value={name}
          placeholder="Unbenannte Szene"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
      </label>
      <label className="ws-field">
        <span>Ablegen in</span>
        <select
          className="ws-input"
          value={collectionId}
          onChange={(event) => setCollectionId(event.target.value)}
        >
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </label>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};
