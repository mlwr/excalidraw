/**
 * Intranet fork: the company's library catalog (L3), instead of
 * libraries.excalidraw.com. Everyone browses it, publishes libraries (a
 * file or one of their own) and adds them with one click: to their own or
 * a team library, or, opened from the editor's "Browse libraries", straight
 * into the open editor.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { randomId } from "@excalidraw/common";

import { BackendError, backendFetch } from "../intranet/api";
import { logoUrl, useBranding } from "../intranet/branding";
import { libraryApi } from "../intranet/libraryApi";
import { getCurrentUser } from "../intranet/session";

import { Avatar, Button, Dialog, Notice, formatRelative } from "./ui";

import "./workspace.scss";

import type { SharedLibraryInfo } from "../intranet/libraryApi";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  items: number;
  downloads: number;
  author: { id: string | null; name: string };
  createdAt: string;
  updatedAt: string;
  preview: string | null;
  canEdit: boolean;
}

const json = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      message = (await response.json()).message || message;
    } catch {
      // keep the status
    }
    throw new BackendError(response.status, message);
  }
  return (response.status === 204 ? undefined : response.json()) as T;
};

const send = (method: string, path: string, body?: unknown) =>
  backendFetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const catalogApi = {
  list: async (query: string) =>
    json<{ entries: CatalogEntry[] }>(
      await backendFetch(
        `/api/library-catalog${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      ),
    ),
  publish: async (body: Record<string, unknown>) =>
    json<{ entry: CatalogEntry }>(
      await send("POST", "/api/library-catalog", body),
    ),
  remove: async (id: string) =>
    json<void>(await send("DELETE", `/api/library-catalog/${id}`)),
  add: async (id: string, libraryId: string) =>
    json<{ added: number }>(
      await send("POST", `/api/library-catalog/${id}/add`, { libraryId }),
    ),
};

/** items of an .excalidrawlib file, version 1 or 2 */
const itemsOfFile = async (file: File) => {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("Die Datei ist keine Bibliothek (.excalidrawlib).");
  }
  if (Array.isArray(data?.libraryItems)) {
    return data.libraryItems as unknown[];
  }
  if (Array.isArray(data?.library)) {
    return (data.library as unknown[][]).map((elements) => ({
      id: randomId(),
      status: "published",
      created: Date.now(),
      elements,
    }));
  }
  throw new Error("Die Datei ist keine Bibliothek (.excalidrawlib).");
};

/** opened from the editor's "Browse libraries": where the editor waits */
const editorHandoff = () => {
  const params = new URLSearchParams(window.location.search);
  const referrer = params.get("referrer");
  const token = params.get("token");
  if (!referrer || !token) {
    return null;
  }
  try {
    const url = new URL(referrer, window.location.origin);
    // never anywhere else than back into this app
    return url.origin === window.location.origin ? { url, token } : null;
  } catch {
    return null;
  }
};

const PublishDialog = ({
  libraries,
  onPublished,
  onClose,
}: {
  libraries: SharedLibraryInfo[];
  onPublished: (entry: CatalogEntry) => void;
  onClose: () => void;
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<string>("file");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, description };
      if (source === "file") {
        if (!file) {
          throw new Error("Bitte eine Datei wählen.");
        }
        body.libraryItems = await itemsOfFile(file);
      } else {
        body.libraryId = source;
      }
      const { entry } = await catalogApi.publish(body);
      onPublished(entry);
      onClose();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Bibliothek veröffentlichen"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={publish}
          >
            {busy ? "Veröffentlicht …" : "Veröffentlichen"}
          </Button>
        </>
      }
    >
      <label className="ws-field">
        <span>Name</span>
        <input
          className="ws-input"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="ws-field">
        <span>Beschreibung (was drin ist, wofür)</span>
        <textarea
          className="ws-input"
          rows={3}
          maxLength={1000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="ws-field">
        <span>Inhalt</span>
        <select
          className="ws-input"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="file">Datei (.excalidrawlib)</option>
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.kind === "personal"
                ? "Meine Bibliothek"
                : `${library.name}${
                    library.scope ? ` (${library.scope.name})` : ""
                  }`}{" "}
              · {library.items} Einträge
            </option>
          ))}
        </select>
      </label>
      {source === "file" && (
        <input
          type="file"
          accept=".excalidrawlib,application/json"
          aria-label="Bibliotheksdatei"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
      )}
      <p className="ws-muted">
        Alle im Unternehmen sehen die Bibliothek im Katalog. Öffentliche
        Bibliotheken (libraries.excalidraw.com) lassen sich so einmalig als
        Datei übernehmen.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
};

export const LibraryCatalog = () => {
  const user = getCurrentUser();
  const branding = useBranding();
  const handoff = useMemo(editorHandoff, []);
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [libraries, setLibraries] = useState<SharedLibraryInfo[]>([]);
  const [target, setTarget] = useState("personal");
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    document.title = `Bibliotheken · ${branding.name}`;
  }, [branding.name]);

  const load = useCallback(async (search: string) => {
    try {
      setEntries((await catalogApi.list(search)).entries);
    } catch (err: any) {
      setMessage({ kind: "error", text: err.message });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    libraryApi
      .list()
      .then((result) =>
        setLibraries(result.libraries.filter((library) => library.canEdit)),
      )
      .catch(() => {
        // adding still works into the own library
      });
  }, []);

  const add = async (entry: CatalogEntry) => {
    setMessage(null);
    if (handoff) {
      // into the open editor: it loads the file and asks nothing more
      const url = new URL(handoff.url.toString());
      const download = new URL(
        `/api/library-catalog/${entry.id}/download`,
        window.location.origin,
      ).toString();
      url.hash = `addLibrary=${encodeURIComponent(
        download,
      )}&token=${encodeURIComponent(handoff.token)}`;
      const opener = window.opener as Window | null;
      if (opener && !opener.closed) {
        try {
          opener.location.assign(url.toString());
          opener.focus();
          setMessage({
            kind: "info",
            text: `„${entry.name}“ ist im Editor. Dieses Fenster kann zu.`,
          });
          return;
        } catch {
          // the editor is gone: open it here
        }
      }
      window.location.assign(url.toString());
      return;
    }
    try {
      const { added } = await catalogApi.add(entry.id, target);
      setMessage({
        kind: "info",
        text: added
          ? `${added} ${added === 1 ? "Eintrag" : "Einträge"} aus „${
              entry.name
            }“ hinzugefügt.`
          : `Alles aus „${entry.name}“ ist schon in der Bibliothek.`,
      });
      load(query.trim());
    } catch (err: any) {
      setMessage({ kind: "error", text: err.message });
    }
  };

  const remove = async (entry: CatalogEntry) => {
    if (!window.confirm(`„${entry.name}“ aus dem Katalog entfernen?`)) {
      return;
    }
    try {
      await catalogApi.remove(entry.id);
      load(query.trim());
    } catch (err: any) {
      setMessage({ kind: "error", text: err.message });
    }
  };

  const logo = logoUrl(branding);

  return (
    <div className="ws-theme ws-dashboard ws-catalog">
      <header className="ws-header">
        <a className="ws-brand" href="/">
          {logo && (
            <span className="ws-brand__logo">
              <img src={logo} alt="" />
            </span>
          )}
          {branding.name}
        </a>
        <div className="ws-header__search">
          <input
            className="ws-input"
            type="search"
            placeholder="Bibliotheken durchsuchen"
            aria-label="Bibliotheken durchsuchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="ws-header__right">
          <a className="ws-link" href="/">
            Zur Übersicht
          </a>
          {user && (
            <span className="ws-user" title={user.email || user.name}>
              <Avatar id={user.id} name={user.name} />
              <span className="ws-user__name">{user.name}</span>
            </span>
          )}
        </div>
      </header>

      <main className="ws-main ws-catalog__main">
        <div className="ws-main__header">
          <div>
            <h1>Bibliotheken</h1>
            <p className="ws-muted">
              {handoff
                ? "Wähle eine Bibliothek für den geöffneten Editor."
                : "Formen und Symbole aus dem Unternehmen, für deine eigene oder eine Team-Bibliothek."}
            </p>
          </div>
          <div className="ws-main__actions">
            {!handoff && libraries.length > 0 && (
              <label className="ws-catalog__target">
                <span>Hinzufügen zu</span>
                <select
                  className="ws-input"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {libraries.map((library) => (
                    <option
                      key={library.id}
                      value={
                        library.kind === "personal" ? "personal" : library.id
                      }
                    >
                      {library.kind === "personal"
                        ? "Meine Bibliothek"
                        : library.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button variant="primary" onClick={() => setPublishing(true)}>
              Veröffentlichen
            </Button>
          </div>
        </div>

        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        {entries === null ? (
          <p className="ws-muted">Lade …</p>
        ) : entries.length === 0 ? (
          <div className="ws-empty">
            <h2>{query ? "Nichts gefunden" : "Noch keine Bibliotheken"}</h2>
            <p className="ws-muted">
              Veröffentliche eine eigene Bibliothek oder übernimm eine Datei aus
              dem öffentlichen Katalog.
            </p>
          </div>
        ) : (
          <section className="ws-catalog__grid" aria-label="Bibliotheken">
            {entries.map((entry) => (
              <article key={entry.id} className="ws-catalog__card">
                <div className="ws-catalog__preview">
                  {entry.preview ? (
                    <img src={entry.preview} alt="" loading="lazy" />
                  ) : (
                    <span className="ws-muted">Keine Vorschau</span>
                  )}
                </div>
                <h2>{entry.name}</h2>
                {entry.description && <p>{entry.description}</p>}
                <p className="ws-muted">
                  {entry.items} {entry.items === 1 ? "Eintrag" : "Einträge"} ·
                  von {entry.author.name} · {formatRelative(entry.updatedAt)}
                  {entry.downloads > 0 && ` · ${entry.downloads}× genutzt`}
                </p>
                <div className="ws-catalog__actions">
                  <Button variant="primary" onClick={() => add(entry)}>
                    {handoff ? "In den Editor" : "Hinzufügen"}
                  </Button>
                  <a
                    className="ws-button ws-button--ghost"
                    href={`/api/library-catalog/${entry.id}/download`}
                    download
                  >
                    Herunterladen
                  </a>
                  {entry.canEdit && (
                    <Button variant="ghost" onClick={() => remove(entry)}>
                      Entfernen
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
      </main>

      {publishing && (
        <PublishDialog
          libraries={libraries}
          onPublished={(entry) => {
            setMessage({
              kind: "info",
              text: `„${entry.name}“ ist im Katalog.`,
            });
            load(query.trim());
          }}
          onClose={() => setPublishing(false)}
        />
      )}
    </div>
  );
};
