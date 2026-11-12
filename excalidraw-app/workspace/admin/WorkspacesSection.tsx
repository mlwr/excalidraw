/**
 * Intranet fork, administration: workspaces (W10) with their members and
 * policies (T5). App admins create, open up and delete workspaces;
 * workspace admins rename theirs and set members and policies.
 */
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";

import { AccessEditor } from "../AccessEditor";
import { ConfirmDialog, NameDialog } from "../DashboardDialogs";
import { Button, Notice } from "../ui";

import type { AdminWorkspace, MemberRole } from "../../intranet/adminApi";
import type { Grant, WorkspacePolicies } from "../../intranet/workspaceApi";

// the access editor speaks in scene roles: members are "editor" there
const MEMBER_LABELS = {
  viewer: "",
  editor: "Mitglied",
  manager: "Admin",
};
const toGrantRole = (role: MemberRole): Grant["role"] =>
  role === "admin" ? "manager" : "editor";
const toMemberRole = (role: Grant["role"]): MemberRole =>
  role === "manager" ? "admin" : "member";

const PolicyForm = ({
  workspace,
  onSaved,
}: {
  workspace: AdminWorkspace;
  onSaved: (workspace: AdminWorkspace) => void;
}) => {
  const [policies, setPolicies] = useState<WorkspacePolicies>(
    workspace.policies,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  useEffect(() => setPolicies(workspace.policies), [workspace]);

  const set = <K extends keyof WorkspacePolicies>(
    key: K,
    value: WorkspacePolicies[K],
  ) => setPolicies((current) => ({ ...current, [key]: value }));

  const switchesOff =
    (workspace.policies.readLinks && !policies.readLinks) ||
    (workspace.policies.directSharing && !policies.directSharing);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { workspace: saved } = await adminApi.updateWorkspace(
        workspace.id,
        { policies },
      );
      onSaved(saved);
      setMessage({ kind: "info", text: "Richtlinien gespeichert." });
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ws-admin__card">
      <h3>Richtlinien</h3>
      <label className="ws-toggle">
        <input
          type="checkbox"
          checked={policies.readLinks}
          onChange={(event) => set("readLinks", event.target.checked)}
        />
        Nur-Lese-Links erlaubt (alle Angemeldeten mit dem Link sehen die Szene)
      </label>
      <label className="ws-toggle">
        <input
          type="checkbox"
          checked={policies.directSharing}
          onChange={(event) => set("directSharing", event.target.checked)}
        />
        Einzelne Szenen dürfen direkt mit Personen und Gruppen geteilt werden
      </label>
      <label className="ws-toggle">
        <input
          type="checkbox"
          checked={policies.export}
          onChange={(event) => set("export", event.target.checked)}
        />
        Alle dürfen den Workspace oder Collections als ZIP exportieren (sonst
        nur Workspace-Admins; einzelne Szenen speichern bleibt möglich)
      </label>
      <label className="ws-field">
        <span>Collections anlegen dürfen</span>
        <select
          className="ws-input"
          value={policies.collectionCreation}
          onChange={(event) =>
            set(
              "collectionCreation",
              event.target.value as WorkspacePolicies["collectionCreation"],
            )
          }
        >
          <option value="members">alle Mitglieder</option>
          <option value="admins">nur Workspace-Admins</option>
        </select>
      </label>
      <label className="ws-field">
        <span>Tage im Papierkorb, bevor Szenen endgültig gelöscht werden</span>
        <input
          className="ws-input ws-admin__number"
          type="number"
          min={1}
          max={3650}
          value={policies.trashRetentionDays}
          onChange={(event) =>
            set("trashRetentionDays", Number(event.target.value))
          }
        />
      </label>
      {switchesOff && (
        <Notice>
          Beim Speichern werden bestehende Nur-Lese-Links bzw. direkte Freigaben
          in diesem Workspace sofort entfernt.
        </Notice>
      )}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="ws-dialog__actions">
        <Button variant="primary" disabled={saving} onClick={save}>
          {saving ? "Speichert …" : "Richtlinien speichern"}
        </Button>
      </div>
    </section>
  );
};

const MembersForm = ({
  workspace,
  onSaved,
}: {
  workspace: AdminWorkspace;
  onSaved: () => void;
}) => {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    setGrants(null);
    setMessage(null);
    adminApi
      .members(workspace.id)
      .then(({ members }) =>
        setGrants(
          members.map((member) => ({
            type: member.type,
            principal: member.principal,
            role: toGrantRole(member.role),
            label: member.label,
          })),
        ),
      )
      .catch((error) => setMessage({ kind: "error", text: error.message }));
  }, [workspace.id]);

  const save = async () => {
    if (!grants) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await adminApi.setMembers(
        workspace.id,
        grants.map((grant) => ({
          type: grant.type,
          principal: grant.principal,
          role: toMemberRole(grant.role),
        })),
      );
      setMessage({ kind: "info", text: "Mitglieder gespeichert." });
      onSaved();
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ws-admin__card">
      <h3>Mitglieder</h3>
      <p className="ws-muted">
        {workspace.openToAll
          ? "Alle Angemeldeten sind Mitglied. Hier eingetragene Admins verwalten den Workspace."
          : "Mitglieder sehen den Workspace und legen dort Szenen und Collections an. Admins verwalten außerdem alle Team-Collections, Mitglieder und Richtlinien. Keycloak-Gruppen schließen ihre Untergruppen ein."}
      </p>
      {grants === null ? (
        <p className="ws-muted">Lade …</p>
      ) : (
        <AccessEditor
          grants={grants}
          roles={["editor", "manager"]}
          labels={MEMBER_LABELS}
          onChange={setGrants}
        />
      )}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="ws-dialog__actions">
        <Button variant="primary" disabled={saving || !grants} onClick={save}>
          {saving ? "Speichert …" : "Mitglieder speichern"}
        </Button>
      </div>
    </section>
  );
};

export const WorkspacesSection = () => {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[] | null>(null);
  const [isAppAdmin, setIsAppAdmin] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "rename" | "delete" | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const result = await adminApi.workspaces();
      setWorkspaces(result.workspaces);
      setIsAppAdmin(result.isAppAdmin);
      setSelectedId(
        (current) =>
          (result.workspaces.some((item) => item.id === current) && current) ||
          result.workspaces[0]?.id ||
          null,
      );
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = workspaces?.find((item) => item.id === selectedId) || null;

  const replace = (workspace: AdminWorkspace) =>
    setWorkspaces(
      (current) =>
        current?.map((item) => (item.id === workspace.id ? workspace : item)) ||
        null,
    );

  const toggleOpen = async (openToAll: boolean) => {
    if (!selected) {
      return;
    }
    try {
      replace(
        (await adminApi.updateWorkspace(selected.id, { openToAll })).workspace,
      );
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (workspaces === null) {
    return <p className="ws-muted">Lade …</p>;
  }

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="ws-admin__split">
        <div className="ws-admin__list">
          <ul aria-label="Workspaces">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  className={clsx(
                    "ws-nav-item",
                    workspace.id === selectedId && "is-active",
                  )}
                  onClick={() => setSelectedId(workspace.id)}
                >
                  <span className="ws-nav-item__label">{workspace.name}</span>
                  <span className="ws-nav-item__count">{workspace.scenes}</span>
                </button>
              </li>
            ))}
          </ul>
          {isAppAdmin && (
            <Button onClick={() => setModal("create")}>Neuer Workspace</Button>
          )}
        </div>

        {selected ? (
          <div className="ws-admin__detail">
            <section className="ws-admin__card">
              <div className="ws-admin__title-row">
                <div>
                  <h3>{selected.name}</h3>
                  <p className="ws-muted">
                    Kurzname <code>{selected.slug}</code> · {selected.scenes}{" "}
                    Szenen · {selected.members} Einträge in der Mitgliederliste
                  </p>
                </div>
                <div className="ws-main__actions">
                  <Button onClick={() => setModal("rename")}>Umbenennen</Button>
                  {isAppAdmin && !selected.isDefault && (
                    <Button variant="ghost" onClick={() => setModal("delete")}>
                      Löschen
                    </Button>
                  )}
                </div>
              </div>
              {isAppAdmin && (
                <label className="ws-toggle">
                  <input
                    type="checkbox"
                    checked={selected.openToAll}
                    onChange={(event) => toggleOpen(event.target.checked)}
                  />
                  Für alle Angemeldeten offen
                </label>
              )}
            </section>
            <MembersForm workspace={selected} onSaved={load} />
            <PolicyForm workspace={selected} onSaved={replace} />
          </div>
        ) : (
          <p className="ws-muted">Kein Workspace, den du verwalten kannst.</p>
        )}
      </div>

      {modal === "create" && (
        <NameDialog
          title="Neuer Workspace"
          label="Name"
          submitLabel="Anlegen"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const { workspace } = await adminApi.createWorkspace({ name });
            await load();
            setSelectedId(workspace.id);
          }}
        />
      )}
      {modal === "rename" && selected && (
        <NameDialog
          title="Workspace umbenennen"
          label="Name"
          initial={selected.name}
          submitLabel="Umbenennen"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            replace(
              (await adminApi.updateWorkspace(selected.id, { name })).workspace,
            );
          }}
        />
      )}
      {modal === "delete" && selected && (
        <ConfirmDialog
          title="Workspace löschen"
          text={`„${selected.name}“ wird gelöscht. Das geht nur, wenn er keine Szenen mehr enthält (auch nicht im Papierkorb).`}
          confirmLabel="Löschen"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await adminApi.deleteWorkspace(selected.id);
            await load();
          }}
        />
      )}
    </>
  );
};
