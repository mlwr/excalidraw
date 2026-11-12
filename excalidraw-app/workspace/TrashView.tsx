/**
 * Intranet fork: the trash (W5). Deleted scenes stay here for the
 * workspace's retention period; people who could edit them (or deleted
 * them) restore them or delete them for good.
 */
import { useCallback, useEffect, useState } from "react";

import { workspaceApi } from "../intranet/workspaceApi";

import { ConfirmDialog } from "./DashboardDialogs";
import { Button, Notice, formatRelative } from "./ui";

import type { TrashedScene } from "../intranet/workspaceApi";

const dateFormat = new Intl.DateTimeFormat("de", { dateStyle: "medium" });

export const TrashView = ({
  workspace,
  retentionDays,
  onChanged,
}: {
  workspace: string;
  retentionDays: number;
  onChanged: () => void;
}) => {
  const [scenes, setScenes] = useState<TrashedScene[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [purging, setPurging] = useState<TrashedScene | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setScenes((await workspaceApi.trash(workspace)).scenes);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setScenes([]);
    }
  }, [workspace]);

  useEffect(() => {
    setScenes(null);
    load();
  }, [load]);

  const restore = async (scene: TrashedScene) => {
    setBusy(scene.id);
    setMessage(null);
    try {
      const { scene: restored } = await workspaceApi.restoreScene(scene.id);
      setMessage(
        restored.collection
          ? `„${scene.name}“ ist wieder in „${restored.collection.name}“.`
          : `„${scene.name}“ ist wiederhergestellt.`,
      );
      await load();
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (scenes === null) {
    return <p className="ws-muted">Lade …</p>;
  }
  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {scenes.length === 0 ? (
        <div className="ws-empty">
          <h2>Der Papierkorb ist leer</h2>
          <p className="ws-muted">
            Gelöschte Szenen bleiben {retentionDays} Tage hier und lassen sich
            so lange wiederherstellen.
          </p>
        </div>
      ) : (
        <table className="ws-table ws-trash" aria-label="Papierkorb">
          <thead>
            <tr>
              <th>Szene</th>
              <th>Gelöscht</th>
              <th>Endgültig weg am</th>
              <th>
                <span className="ws-visually-hidden">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scenes.map((scene) => (
              <tr key={scene.id}>
                <td>
                  <strong>{scene.name}</strong>
                  {scene.collection && (
                    <div className="ws-muted ws-trash__where">
                      aus „{scene.collection.name}“
                    </div>
                  )}
                </td>
                <td>
                  {formatRelative(scene.deletedAt)}
                  {scene.deletedBy ? ` von ${scene.deletedBy}` : ""}
                </td>
                <td>{dateFormat.format(new Date(scene.purgeAt))}</td>
                <td className="ws-table__actions">
                  <Button
                    disabled={busy === scene.id}
                    onClick={() => restore(scene)}
                  >
                    Wiederherstellen
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy === scene.id}
                    onClick={() => setPurging(scene)}
                  >
                    Endgültig löschen
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {purging && (
        <ConfirmDialog
          title="Endgültig löschen"
          text={`„${purging.name}“ wird mit allen Versionen, Kommentaren und Bildern gelöscht. Das lässt sich nicht rückgängig machen.`}
          confirmLabel="Endgültig löschen"
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            await workspaceApi.purgeScene(purging.id);
            setMessage(`„${purging.name}“ ist endgültig gelöscht.`);
            await load();
          }}
        />
      )}
    </>
  );
};
