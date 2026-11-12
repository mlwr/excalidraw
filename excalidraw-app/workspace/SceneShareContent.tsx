import { useCallback, useEffect, useState } from "react";

import { workspaceApi } from "../intranet/workspaceApi";

import { AccessEditor } from "./AccessEditor";
import { Button, Notice } from "./ui";

import type { Grant, SceneSummary } from "../intranet/workspaceApi";

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** who can see a scene, plus its read-only link */
export const SceneShareContent = ({
  scene,
  onDone,
}: {
  scene: Pick<SceneSummary, "id" | "name">;
  onDone: () => void;
}) => {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        grants: Grant[];
        canManage: boolean;
        collection: { name: string; kind: "personal" | "team" };
        readLinkUrl: string | null;
        policies: { readLinks: boolean; directSharing: boolean };
      }
  >({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sceneUrl = `${window.location.origin}/s/${scene.id}`;

  const load = useCallback(() => {
    workspaceApi
      .sceneGrants(scene.id)
      .then((result) => setState({ status: "ready", ...result }))
      .catch((error) => setState({ status: "error", message: error.message }));
  }, [scene.id]);

  useEffect(load, [load]);

  if (state.status === "loading") {
    return <p className="ws-muted">Lade …</p>;
  }
  if (state.status === "error") {
    return <Notice kind="error">{state.message}</Notice>;
  }

  const setReadLink = async (enabled: boolean) => {
    setMessage(null);
    try {
      if (enabled) {
        const { url } = await workspaceApi.createReadLink(scene.id);
        setState({ ...state, readLinkUrl: url });
      } else {
        await workspaceApi.deleteReadLink(scene.id);
        setState({ ...state, readLinkUrl: null });
      }
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  // the workspace's policies (T5) may switch sharing off
  const canShare = state.canManage && state.policies.directSharing;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await workspaceApi.setSceneGrants(
        scene.id,
        state.grants.map(({ type, principal, role }) => ({
          type,
          principal,
          role,
        })),
      );
      onDone();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-share">
      <section>
        <h3>Link zur Szene</h3>
        <p className="ws-muted">Für alle, die bereits Zugriff haben.</p>
        <div className="ws-copy-row">
          <input
            className="ws-input"
            readOnly
            value={sceneUrl}
            aria-label="Link zur Szene"
          />
          <Button
            onClick={async () =>
              setMessage(
                (await copy(sceneUrl))
                  ? "Link kopiert."
                  : "Kopieren nicht möglich.",
              )
            }
          >
            Kopieren
          </Button>
        </div>
      </section>

      <section>
        <h3>Personen und Gruppen</h3>
        <p className="ws-muted">
          {state.collection.kind === "team"
            ? `Alle mit Zugriff auf die Collection „${state.collection.name}“ sehen diese Szene ebenfalls.`
            : "Die Szene liegt in „Meine Szenen“. Außer dir sehen sie nur die hier eingetragenen Personen und Gruppen."}
        </p>
        <AccessEditor
          grants={state.grants}
          roles={["viewer", "editor"]}
          disabled={!canShare}
          onChange={(grants) => setState({ ...state, grants })}
        />
        {!state.canManage ? (
          <Notice>
            Teilen dürfen nur Personen mit Bearbeitungsrechten an der
            Collection.
          </Notice>
        ) : (
          !state.policies.directSharing && (
            <Notice>
              In diesem Workspace ist das Teilen einzelner Szenen abgeschaltet.
              Zugriff gibt es über die Collection.
            </Notice>
          )
        )}
      </section>

      {state.canManage && state.policies.readLinks && (
        <section>
          <h3>Nur-Lese-Link</h3>
          <label className="ws-toggle">
            <input
              type="checkbox"
              checked={!!state.readLinkUrl}
              onChange={(event) => setReadLink(event.target.checked)}
            />
            Alle angemeldeten Mitarbeitenden mit dem Link können die Szene
            ansehen
          </label>
          {state.readLinkUrl && (
            <div className="ws-copy-row">
              <input
                className="ws-input"
                readOnly
                value={state.readLinkUrl}
                aria-label="Nur-Lese-Link"
              />
              <Button
                onClick={async () =>
                  setMessage(
                    (await copy(state.readLinkUrl!))
                      ? "Nur-Lese-Link kopiert."
                      : "Kopieren nicht möglich.",
                  )
                }
              >
                Kopieren
              </Button>
            </div>
          )}
          <p className="ws-muted">Abschalten macht den Link sofort ungültig.</p>
        </section>
      )}

      {message && <Notice>{message}</Notice>}

      <div className="ws-dialog__actions">
        <Button onClick={onDone}>{canShare ? "Abbrechen" : "Schließen"}</Button>
        {canShare && (
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? "Speichert …" : "Speichern"}
          </Button>
        )}
      </div>
    </div>
  );
};
