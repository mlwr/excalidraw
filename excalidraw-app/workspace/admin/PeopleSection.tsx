/**
 * Intranet fork, administration: people (S3). Lock accounts, end API
 * tokens, and remove people for data protection reasons (e.g. after they
 * left): their personal scenes go to a successor or into the trash.
 */
import { useCallback, useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";
import { getCurrentUser } from "../../intranet/session";

import { ConfirmDialog } from "../DashboardDialogs";
import { Avatar, Button, Dialog, Notice, formatRelative } from "../ui";

import type { AdminUser } from "../../intranet/adminApi";

const EraseDialog = ({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (message: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AdminUser[]>([]);
  const [successor, setSuccessor] = useState<AdminUser | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      adminApi
        .users(q)
        .then(({ users }) => {
          if (!cancelled) {
            setCandidates(
              users.filter(
                (item) =>
                  item.id !== user.id && !item.disabledAt && !item.erasedAt,
              ),
            );
          }
        })
        .catch(() => !cancelled && setCandidates([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, user.id]);

  const erase = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.eraseUser(user.id, successor?.id || null);
      onDone(
        successor
          ? `${user.name} ist entfernt. ${result.moved} Szene(n) gehören jetzt ${successor.name}.`
          : `${user.name} ist entfernt. ${result.trashed} Szene(n) liegen im Papierkorb.`,
      );
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`${user.name} entfernen`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            disabled={busy || confirm.trim() !== user.name.trim()}
            onClick={erase}
          >
            Endgültig entfernen
          </Button>
        </>
      }
    >
      <p>
        Name, E-Mail und Gruppen werden gelöscht, Sitzungen und API-Tokens
        beendet, alle Freigaben und Mitgliedschaften entfernt. Im Audit-Log und
        in Szenen erscheint die Person danach als „Gelöschte Person“. Meldet sie
        sich später wieder an, bekommt sie ein neues, leeres Konto.
      </p>
      <label className="ws-field">
        <span>Persönliche Szenen übernimmt (optional)</span>
        {successor ? (
          <span className="ws-admin__picked">
            <Avatar id={successor.id} name={successor.name} />
            {successor.name}
            <Button variant="ghost" onClick={() => setSuccessor(null)}>
              Ändern
            </Button>
          </span>
        ) : (
          <input
            className="ws-input"
            placeholder="Name oder E-Mail suchen …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </label>
      {!successor && candidates.length > 0 && (
        <ul className="ws-access__suggestions">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                onClick={() => {
                  setSuccessor(candidate);
                  setQuery("");
                }}
              >
                <Avatar id={candidate.id} name={candidate.name} />
                <span className="ws-access__suggestion-text">
                  <strong>{candidate.name}</strong>
                  <small>{candidate.email || candidate.username}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!successor && (
        <p className="ws-muted">
          Ohne Nachfolge kommen die persönlichen Szenen in den Papierkorb und
          werden nach dessen Frist gelöscht.
        </p>
      )}
      <label className="ws-field">
        <span>Zur Bestätigung den Namen eingeben: {user.name}</span>
        <input
          className="ws-input"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </label>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

export const PeopleSection = () => {
  const me = getCurrentUser();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [action, setAction] = useState<
    | { kind: "disable" | "revoke"; user: AdminUser }
    | { kind: "erase"; user: AdminUser }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      const result = await adminApi.users(query.trim());
      setUsers(result.users);
      setNext(result.next);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setUsers([]);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const more = async () => {
    if (next === null) {
      return;
    }
    const result = await adminApi.users(query.trim(), next);
    setUsers((current) => [...(current || []), ...result.users]);
    setNext(result.next);
  };

  const enable = async (user: AdminUser) => {
    try {
      await adminApi.enableUser(user.id);
      setMessage(`${user.name} kann sich wieder anmelden.`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="ws-admin__toolbar">
        <input
          className="ws-input"
          type="search"
          placeholder="Name, E-Mail oder Benutzername …"
          aria-label="Personen suchen"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {users === null ? (
        <p className="ws-muted">Lade …</p>
      ) : (
        <table className="ws-table ws-admin__table" aria-label="Personen">
          <thead>
            <tr>
              <th>Person</th>
              <th>Gruppen</th>
              <th>Zuletzt angemeldet</th>
              <th>Status</th>
              <th>
                <span className="ws-visually-hidden">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className={user.disabledAt ? "is-muted" : ""}>
                <td>
                  <span className="ws-admin__person">
                    <Avatar id={user.id} name={user.name} />
                    <span>
                      <strong>{user.name}</strong>
                      <small>{user.email || user.username || ""}</small>
                    </span>
                  </span>
                </td>
                <td className="ws-admin__groups">
                  {user.groups.join(", ") || "–"}
                </td>
                <td>
                  {user.lastLoginAt ? formatRelative(user.lastLoginAt) : "–"}
                </td>
                <td>
                  {user.erasedAt
                    ? "entfernt"
                    : user.disabledAt
                    ? "gesperrt"
                    : user.isAdmin
                    ? "aktiv · App-Admin"
                    : "aktiv"}
                  {user.activeTokens > 0 && (
                    <div className="ws-muted ws-admin__small">
                      {user.activeTokens} API-Token
                    </div>
                  )}
                </td>
                <td className="ws-table__actions">
                  {!user.erasedAt && user.id !== me?.id && (
                    <>
                      {user.disabledAt ? (
                        <Button onClick={() => enable(user)}>Entsperren</Button>
                      ) : (
                        <Button
                          onClick={() => setAction({ kind: "disable", user })}
                        >
                          Sperren
                        </Button>
                      )}
                      {user.activeTokens > 0 && (
                        <Button
                          onClick={() => setAction({ kind: "revoke", user })}
                        >
                          Tokens beenden
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => setAction({ kind: "erase", user })}
                      >
                        Entfernen …
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next !== null && (
        <div className="ws-feed__more">
          <Button onClick={more}>Weitere</Button>
        </div>
      )}
      <p className="ws-muted">
        Personen erscheinen hier nach ihrer ersten Anmeldung. Wer in Keycloak
        deaktiviert wird oder die App-Rolle verliert, kommt beim nächsten
        Anmelden nicht mehr hinein; Sperren hier wirkt sofort.
      </p>

      {action?.kind === "disable" && (
        <ConfirmDialog
          title={`${action.user.name} sperren`}
          text="Alle Sitzungen und API-Tokens enden sofort, eine Anmeldung ist nicht mehr möglich. Szenen und Freigaben bleiben erhalten."
          confirmLabel="Sperren"
          onClose={() => setAction(null)}
          onConfirm={async () => {
            await adminApi.disableUser(action.user.id);
            setMessage(`${action.user.name} ist gesperrt.`);
            load();
          }}
        />
      )}
      {action?.kind === "revoke" && (
        <ConfirmDialog
          title="API-Tokens beenden"
          text={`Alle API-Tokens von ${action.user.name} werden sofort ungültig (z. B. für KI-Assistenten über MCP).`}
          confirmLabel="Tokens beenden"
          onClose={() => setAction(null)}
          onConfirm={async () => {
            const { revoked } = await adminApi.revokeTokens(action.user.id);
            setMessage(`${revoked} Token(s) beendet.`);
            load();
          }}
        />
      )}
      {action?.kind === "erase" && (
        <EraseDialog
          user={action.user}
          onClose={() => setAction(null)}
          onDone={(text) => {
            setAction(null);
            setMessage(text);
            load();
          }}
        />
      )}
    </>
  );
};
