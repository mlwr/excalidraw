/**
 * Intranet fork, administration: AI (K2). On or off, who may use it, how
 * many requests per person and day, and how much it is used (per day, not
 * per person).
 */
import { useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";

import { Button, Notice } from "../ui";

import type { AiOverview } from "../../intranet/adminApi";

const dayFormat = new Intl.DateTimeFormat("de", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

export const AiSection = () => {
  const [overview, setOverview] = useState<AiOverview | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [dailyLimit, setDailyLimit] = useState(50);
  const [requiredRole, setRequiredRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    adminApi
      .ai()
      .then((result) => {
        setOverview(result);
        setEnabled(result.settings.enabled);
        setDailyLimit(result.settings.dailyLimit);
        setRequiredRole(result.settings.requiredRole || "");
      })
      .catch((error) => setMessage({ kind: "error", text: error.message }));
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await adminApi.saveAi({
        enabled,
        dailyLimit,
        requiredRole: requiredRole.trim() || null,
      });
      setMessage({
        kind: "info",
        text: "Gespeichert. Es gilt ab dem nächsten Laden der App.",
      });
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  if (!overview) {
    return message ? (
      <Notice kind={message.kind}>{message.text}</Notice>
    ) : (
      <p className="ws-muted">Lade …</p>
    );
  }

  return (
    <div className="ws-admin__detail">
      <section className="ws-admin__card">
        <h3>Sprachmodell</h3>
        {overview.configured ? (
          <ul className="ws-admin__facts">
            <li>
              Endpunkt: <code>{overview.endpoint}</code>
            </li>
            <li>
              Text zu Diagramm: <code>{overview.model}</code>
            </li>
            <li>
              Wireframe zu Code:{" "}
              {overview.visionModel ? (
                <code>{overview.visionModel}</code>
              ) : (
                "nicht eingerichtet (kein Modell mit Bildverständnis)"
              )}
            </li>
          </ul>
        ) : (
          <Notice>
            Keine KI eingerichtet. Der Betrieb setzt dafür{" "}
            <code>AI_BASE_URL</code> (OpenAI-kompatibler Endpunkt) und{" "}
            <code>AI_MODEL</code>.
          </Notice>
        )}
        <p className="ws-muted">
          Eingaben und Antworten werden nur durchgereicht, nicht gespeichert.
          Gezählt werden Anfragen und Tokens pro Person und Tag, für das
          Tageslimit; angezeigt wird nur die Summe pro Tag.
        </p>
      </section>

      <section className="ws-admin__card">
        <h3>Freigabe und Kontingent</h3>
        <label className="ws-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          KI-Funktionen eingeschaltet (Text zu Diagramm, Wireframe zu Code)
        </label>
        <label className="ws-field">
          <span>Anfragen pro Person und Tag</span>
          <input
            className="ws-input ws-admin__number"
            type="number"
            min={0}
            max={10000}
            value={dailyLimit}
            onChange={(event) => setDailyLimit(Number(event.target.value))}
          />
        </label>
        <label className="ws-field">
          <span>Nur für Personen mit dieser Keycloak-Rolle (leer = alle)</span>
          <input
            className="ws-input"
            value={requiredRole}
            placeholder="z. B. excalidraw-ki"
            onChange={(event) => setRequiredRole(event.target.value)}
          />
        </label>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <div className="ws-dialog__actions">
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? "Speichert …" : "Speichern"}
          </Button>
        </div>
      </section>

      <section className="ws-admin__card">
        <h3>Nutzung der letzten 30 Tage</h3>
        {overview.usage.length === 0 ? (
          <p className="ws-muted">Noch keine Anfragen.</p>
        ) : (
          <table className="ws-table" aria-label="KI-Nutzung">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Anfragen</th>
                <th>Personen</th>
                <th>Tokens (Eingabe / Ausgabe)</th>
              </tr>
            </thead>
            <tbody>
              {overview.usage.map((row) => (
                <tr key={row.day}>
                  <td>{dayFormat.format(new Date(`${row.day}T12:00:00`))}</td>
                  <td>{row.requests.toLocaleString("de")}</td>
                  <td>{row.people.toLocaleString("de")}</td>
                  <td>
                    {row.promptTokens.toLocaleString("de")} /{" "}
                    {row.completionTokens.toLocaleString("de")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
