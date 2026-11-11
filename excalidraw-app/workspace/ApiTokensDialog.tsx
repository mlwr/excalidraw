import { useEffect, useState } from "react";

import { workspaceApi } from "../intranet/workspaceApi";

import { Button, Dialog, Notice, formatRelative } from "./ui";

import type { ApiTokenInfo } from "../intranet/workspaceApi";

const SCOPE_LABELS = {
  read: "Nur lesen",
  write: "Lesen und schreiben",
};

const VALIDITY_DAYS = [30, 90, 180, 365];

const CopyField = ({ label, value }: { label: string; value: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ws-copy">
      <textarea
        className="ws-input ws-copy__value"
        aria-label={label}
        readOnly
        rows={Math.min(8, value.split("\n").length)}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // clipboard blocked: the text is selectable
          }
        }}
      >
        {copied ? "Kopiert" : "Kopieren"}
      </Button>
    </div>
  );
};

/** personal tokens for the REST API and the MCP server */
export const ApiTokensDialog = ({ onClose }: { onClose: () => void }) => {
  const [state, setState] = useState<{
    allowed: boolean;
    maxDays: number;
    loginMaxAgeDays: number;
    mcpEnabled: boolean;
    tokens: ApiTokenInfo[];
  } | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    workspaceApi
      .tokens()
      .then((result) => {
        setState(result);
        setDays((current) => Math.min(current, result.maxDays));
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!name.trim()) {
      setError("Bitte einen Namen angeben, z. B. wofür das Token gedacht ist.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspaceApi.createToken({
        name: name.trim(),
        scope,
        expiresInDays: days,
      });
      setCreated(result.token);
      setName("");
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ApiTokenInfo) => {
    setError(null);
    try {
      await workspaceApi.revokeToken(token.id);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const origin = window.location.origin;
  const shown = created || "<TOKEN>";

  return (
    <Dialog
      title="API-Tokens"
      onClose={onClose}
      size="wide"
      footer={<Button onClick={onClose}>Schließen</Button>}
    >
      <p className="ws-muted">
        Mit einem persönlichen Token greifen Skripte (REST-API) und
        KI-Assistenten (MCP) auf deine Szenen zu – mit genau deinen Rechten. Gib
        Tokens nicht weiter.
        {state && state.loginMaxAgeDays > 0 && (
          <>
            {" "}
            Tokens wirken, solange du dich mindestens alle{" "}
            {state.loginMaxAgeDays} Tage in Excalidraw anmeldest.
          </>
        )}
      </p>

      {state && !state.allowed && (
        <Notice>Dein Konto darf keine API-Tokens anlegen.</Notice>
      )}

      {created && (
        <div className="ws-token-created">
          <Notice>
            Neues Token – es wird nur jetzt angezeigt. Bitte sicher ablegen.
          </Notice>
          <CopyField label="Neues API-Token" value={created} />
        </div>
      )}

      {state?.allowed && (
        <div className="ws-token-form">
          <label className="ws-field">
            <span>Name</span>
            <input
              className="ws-input"
              value={name}
              maxLength={100}
              placeholder="z. B. Assistent im Browser, Build-Skript"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && create()}
            />
          </label>
          <label className="ws-field">
            <span>Rechte</span>
            <select
              className="ws-input"
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as "read" | "write")
              }
            >
              <option value="read">{SCOPE_LABELS.read}</option>
              <option value="write">{SCOPE_LABELS.write}</option>
            </select>
          </label>
          <label className="ws-field">
            <span>Gültig</span>
            <select
              className="ws-input"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {VALIDITY_DAYS.filter((value) => value <= state.maxDays).map(
                (value) => (
                  <option key={value} value={value}>
                    {value} Tage
                  </option>
                ),
              )}
            </select>
          </label>
          <Button variant="primary" disabled={busy} onClick={create}>
            Token erzeugen
          </Button>
        </div>
      )}

      {error && <Notice kind="error">{error}</Notice>}

      {state && state.tokens.length > 0 && (
        <table className="ws-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Rechte</th>
              <th>Zuletzt benutzt</th>
              <th>Läuft ab</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.tokens.map((token) => (
              <tr key={token.id} className={token.expired ? "is-muted" : ""}>
                <td>
                  {token.name}
                  <span className="ws-muted"> …{token.hint}</span>
                </td>
                <td>{SCOPE_LABELS[token.scope]}</td>
                <td>
                  {token.lastUsedAt ? formatRelative(token.lastUsedAt) : "nie"}
                </td>
                <td>
                  {token.expired
                    ? "abgelaufen"
                    : new Date(token.expiresAt).toLocaleDateString("de-DE")}
                </td>
                <td>
                  <Button variant="ghost" onClick={() => revoke(token)}>
                    Widerrufen
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="ws-details">
        <summary>So wird ein Token benutzt</summary>
        <p className="ws-muted">
          REST-API (Beschreibung: {origin}/api/v1/openapi.json):
        </p>
        <CopyField
          label="Beispiel REST-API"
          value={`curl -H "Authorization: Bearer ${shown}" ${origin}/api/v1/scenes`}
        />
        {state?.mcpEnabled && (
          <>
            <p className="ws-muted">
              KI-Assistent mit MCP (Streamable HTTP), z. B. in der Konfiguration
              des Assistenten:
            </p>
            <CopyField
              label="Beispiel MCP-Konfiguration"
              value={JSON.stringify(
                {
                  mcpServers: {
                    excalidraw: {
                      type: "http",
                      url: `${origin}/mcp`,
                      headers: { Authorization: `Bearer ${shown}` },
                    },
                  },
                },
                null,
                2,
              )}
            />
          </>
        )}
      </details>
    </Dialog>
  );
};
