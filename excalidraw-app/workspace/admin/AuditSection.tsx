/**
 * Intranet fork, administration: audit log (S2). Who signed in, who
 * changed which access, who exported, what admins did. Kept for
 * AUDIT_RETENTION_DAYS; downloadable as CSV.
 */
import { useCallback, useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";

import { Button, Notice } from "../ui";

import type { AuditEvent, AuditFilter } from "../../intranet/adminApi";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "", label: "Alle Ereignisse" },
  { value: "auth.", label: "Anmeldungen" },
  { value: "token.", label: "API-Tokens" },
  { value: "share.", label: "Freigaben und Links" },
  { value: "collection.", label: "Collections" },
  { value: "scene.", label: "Szenen" },
  { value: "comment.", label: "Kommentare" },
  { value: "workspace.", label: "Workspaces und Exporte" },
  { value: "admin.", label: "Verwaltung" },
];

const LABELS: Record<string, string> = {
  "auth.login": "Anmeldung",
  "auth.login_denied": "Anmeldung abgelehnt",
  "auth.logout": "Abmeldung",
  "token.created": "API-Token erstellt",
  "token.revoked": "API-Token widerrufen",
  "scene.created": "Szene angelegt",
  "scene.renamed": "Szene umbenannt",
  "scene.moved": "Szene verschoben",
  "scene.edited": "Szene bearbeitet",
  "scene.deleted": "Szene gelöscht (Papierkorb)",
  "scene.restored": "Szene wiederhergestellt",
  "scene.purged": "Szene endgültig gelöscht",
  "scene.version_restored": "Version wiederhergestellt",
  "share.scene_grants": "Freigaben der Szene geändert",
  "share.read_link_created": "Nur-Lese-Link erstellt",
  "share.read_link_deleted": "Nur-Lese-Link entfernt",
  "collection.created": "Collection angelegt",
  "collection.renamed": "Collection umbenannt",
  "collection.moved": "Collection verschoben",
  "collection.deleted": "Collection gelöscht",
  "collection.grants": "Zugriff auf Collection geändert",
  "comment.created": "Kommentar",
  "comment.replied": "Antwort",
  "comment.resolved": "Kommentar erledigt",
  "comment.reopened": "Kommentar wieder geöffnet",
  "comment.deleted": "Kommentar gelöscht",
  "workspace.created": "Workspace angelegt",
  "workspace.updated": "Workspace geändert",
  "workspace.deleted": "Workspace gelöscht",
  "workspace.members": "Mitglieder geändert",
  "workspace.exported": "Export (ZIP)",
  "admin.user_disabled": "Person gesperrt",
  "admin.user_enabled": "Person entsperrt",
  "admin.user_erased": "Person entfernt",
  "admin.tokens_revoked": "Tokens einer Person beendet",
  "admin.branding": "Branding geändert",
  "admin.audit_exported": "Audit-Log heruntergeladen",
};

const dateTime = new Intl.DateTimeFormat("de", {
  dateStyle: "short",
  timeStyle: "medium",
});

/** the day after a yyyy-mm-dd date: "to" includes the whole day */
const dayAfter = (date: string) => {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
};

const details = (event: AuditEvent) => {
  const parts = Object.entries(event.data || {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
    );
  if (event.target) {
    parts.unshift(`Ziel: ${event.target}`);
  }
  return parts.join(" · ");
};

export const AuditSection = () => {
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filter: AuditFilter = {
    type: category || undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? dayAfter(to) : undefined,
  };
  const filterKey = JSON.stringify(filter);

  const load = useCallback(async () => {
    try {
      const result = await adminApi.audit(JSON.parse(filterKey));
      setEvents(result.events);
      setNext(result.next);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setEvents([]);
    }
  }, [filterKey]);

  useEffect(() => {
    load();
  }, [load]);

  const more = async () => {
    if (!next) {
      return;
    }
    try {
      const result = await adminApi.audit(filter, next);
      setEvents((current) => [...(current || []), ...result.events]);
      setNext(result.next);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="ws-admin__toolbar">
        <select
          className="ws-input"
          aria-label="Art der Ereignisse"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {CATEGORIES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <label className="ws-admin__date">
          von
          <input
            className="ws-input"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="ws-admin__date">
          bis
          <input
            className="ws-input"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <a
          className="ws-button ws-button--secondary"
          href={adminApi.auditCsvUrl(filter)}
          download
        >
          Als CSV herunterladen
        </a>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {events === null ? (
        <p className="ws-muted">Lade …</p>
      ) : events.length === 0 ? (
        <p className="ws-muted">Keine Ereignisse für diese Auswahl.</p>
      ) : (
        <table className="ws-table ws-admin__table" aria-label="Audit-Log">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Ereignis</th>
              <th>Person</th>
              <th>Details</th>
              <th>Adresse</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="ws-admin__nowrap">
                  {dateTime.format(new Date(event.at))}
                </td>
                <td>
                  {LABELS[event.type] || event.type}
                  <div className="ws-muted ws-admin__small">
                    <code>{event.type}</code>
                  </div>
                </td>
                <td>{event.actor_name || "System"}</td>
                <td className="ws-admin__details">
                  {details(event)}
                  {event.scene_id && (
                    <div className="ws-muted ws-admin__small">
                      Szene <code>{event.scene_id}</code>
                    </div>
                  )}
                </td>
                <td className="ws-admin__small">{event.ip || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <div className="ws-feed__more">
          <Button onClick={more}>Ältere Ereignisse</Button>
        </div>
      )}
    </>
  );
};
