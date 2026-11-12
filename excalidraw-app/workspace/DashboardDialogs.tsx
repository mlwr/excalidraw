import { useEffect, useState } from "react";

import { workspaceApi } from "../intranet/workspaceApi";

import { AccessEditor } from "./AccessEditor";
import { collectionLabel, subtreeIds } from "./collectionTree";
import { Button, Dialog, Notice, ROLE_LABELS } from "./ui";

import type {
  CollectionInfo,
  Grant,
  SceneSummary,
} from "../intranet/workspaceApi";
import type { ReactNode } from "react";

/** asks for a name (new collection, rename) */
export const NameDialog = ({
  title,
  label,
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
  extra,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
  /** more fields below the name */
  extra?: ReactNode;
}) => {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Bitte einen Namen angeben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <label className="ws-field">
        <span>{label}</span>
        <input
          className="ws-input"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </label>
      {extra}
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

export const ConfirmDialog = ({
  title,
  text,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (err: any) {
                setError(err.message);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{text}</p>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

export const MoveDialog = ({
  scene,
  collections,
  onMoved,
  onClose,
}: {
  scene: SceneSummary;
  collections: CollectionInfo[];
  onMoved: () => void;
  onClose: () => void;
}) => {
  const targets = collections.filter(
    (collection) =>
      (collection.role === "editor" || collection.role === "manager") &&
      collection.id !== scene.collection?.id,
  );
  const [target, setTarget] = useState(targets[0]?.id || "");
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      title={`„${scene.name}“ verschieben`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!target}
            onClick={async () => {
              try {
                await workspaceApi.updateScene(scene.id, {
                  collectionId: target,
                });
                onMoved();
                onClose();
              } catch (err: any) {
                setError(err.message);
              }
            }}
          >
            Verschieben
          </Button>
        </>
      }
    >
      {targets.length ? (
        <label className="ws-field">
          <span>Ziel</span>
          <select
            className="ws-input"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {targets.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.kind === "personal"
                  ? "Meine Szenen"
                  : collectionLabel(collections, collection.id)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="ws-muted">
          Es gibt keine andere Collection, in der du Szenen ablegen darfst.
        </p>
      )}
      <p className="ws-muted">
        Danach gelten die Zugriffsrechte der Ziel-Collection. Direkt
        eingetragene Personen behalten ihren Zugriff.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

/** members of a team collection */
export const CollectionAccessDialog = ({
  collection,
  onClose,
}: {
  collection: CollectionInfo;
  onClose: () => void;
}) => {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [inherited, setInherited] = useState<
    { collection: { id: string; name: string } | null; grants: Grant[] }[]
  >([]);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workspaceApi
      .collectionGrants(collection.id)
      .then((result) => {
        setGrants(result.grants);
        setInherited(result.inherited || []);
        setCanManage(result.canManage);
      })
      .catch((err) => setError(err.message));
  }, [collection.id]);

  const save = async () => {
    if (!grants) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.setCollectionGrants(
        collection.id,
        grants.map(({ type, principal, role }) => ({ type, principal, role })),
      );
      onClose();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Zugriff auf „${collection.name}“`}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>
            {canManage ? "Abbrechen" : "Schließen"}
          </Button>
          {canManage && (
            <Button variant="primary" disabled={busy || !grants} onClick={save}>
              {busy ? "Speichert …" : "Speichern"}
            </Button>
          )}
        </>
      }
    >
      <p className="ws-muted">
        Wer hier eingetragen ist, sieht alle Szenen der Collection. „Verwaltet“
        erlaubt zusätzlich, Zugriffe und den Namen zu ändern.
      </p>
      {grants ? (
        <AccessEditor
          grants={grants}
          roles={["viewer", "editor", "manager"]}
          disabled={!canManage}
          onChange={setGrants}
        />
      ) : (
        !error && <p className="ws-muted">Lade …</p>
      )}
      {inherited.length > 0 && (
        <div className="ws-inherited">
          <p className="ws-muted">
            Zusätzlich gilt der Zugriff der übergeordneten Ordner:
          </p>
          <ul>
            {inherited.map((entry, index) => (
              <li key={entry.collection?.id || `hidden-${index}`}>
                <strong>
                  {entry.collection
                    ? `„${entry.collection.name}“`
                    : "ein übergeordneter Ordner"}
                  :
                </strong>{" "}
                {entry.grants
                  .map(
                    (grant) =>
                      `${grant.label || grant.principal} (${
                        ROLE_LABELS[grant.role as keyof typeof ROLE_LABELS] ||
                        grant.role
                      })`,
                  )
                  .join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

/** W4: a collection into another one, or to the top */
export const MoveCollectionDialog = ({
  collection,
  collections,
  allowTop,
  onMoved,
  onClose,
}: {
  collection: CollectionInfo;
  collections: CollectionInfo[];
  /** top level: only if this person may create collections there */
  allowTop: boolean;
  onMoved: () => void;
  onClose: () => void;
}) => {
  const inside = subtreeIds(collections, collection.id);
  const targets = collections.filter(
    (item) =>
      item.kind === "team" &&
      (item.role === "editor" || item.role === "manager") &&
      !inside.has(item.id) &&
      item.id !== collection.parentId,
  );
  const options = [
    ...(allowTop && collection.parentId
      ? [{ id: "", label: "Oberste Ebene" }]
      : []),
    ...targets.map((item) => ({
      id: item.id,
      label: collectionLabel(collections, item.id),
    })),
  ];
  const [target, setTarget] = useState<string | null>(
    options[0] ? options[0].id : null,
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      title={`„${collection.name}“ verschieben`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={target === null}
            onClick={async () => {
              try {
                await workspaceApi.moveCollection(
                  collection.id,
                  target || null,
                );
                onMoved();
                onClose();
              } catch (err: any) {
                setError(err.message);
              }
            }}
          >
            Verschieben
          </Button>
        </>
      }
    >
      {options.length ? (
        <label className="ws-field">
          <span>Ziel</span>
          <select
            className="ws-input"
            value={target ?? ""}
            onChange={(event) => setTarget(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id || "top"} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="ws-muted">
          Es gibt keinen Ordner, in den du diesen verschieben darfst.
        </p>
      )}
      <p className="ws-muted">
        Unterordner kommen mit. Danach gilt zusätzlich der Zugriff des neuen
        übergeordneten Ordners; eigene Freigaben bleiben.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};
