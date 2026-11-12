/**
 * Intranet fork, administration: the editor for everyone. Which web pages
 * scenes may embed (E2), which fonts everyone has (E3).
 */
import { useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";

import { Button, Notice } from "../ui";

import type { CompanyFont } from "../../intranet/fonts";
import type { ReactNode } from "react";

type Message = { kind: "info" | "error"; text: string } | null;

const EmbedsCard = () => {
  const [hosts, setHosts] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  const [configured, setConfigured] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  useEffect(() => {
    adminApi
      .embeds()
      .then((result) => {
        setHosts(result.settings.allowedHosts.join("\n"));
        setExternal(result.settings.external);
        setConfigured(result.configured);
      })
      .catch((error) => setMessage({ kind: "error", text: error.message }));
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await adminApi.saveEmbeds({
        allowedHosts: (hosts || "")
          .split(/[\s,]+/)
          .map((host) => host.trim())
          .filter(Boolean),
        external,
      });
      setHosts(result.settings.allowedHosts.join("\n"));
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

  if (hosts === null) {
    return message ? (
      <Notice kind={message.kind}>{message.text}</Notice>
    ) : (
      <p className="ws-muted">Lade …</p>
    );
  }

  return (
    <section className="ws-admin__card">
      <h3>Einbettungen in Szenen</h3>
      <p className="ws-muted">
        Mit dem Werkzeug „Web-Einbettung“ zeigen Szenen andere Seiten, etwa
        Wiki, Dashboards oder GitLab. Erlaubt ist nur, was hier steht.
      </p>
      <label className="ws-field">
        <span>
          Interne Hosts, einer pro Zeile (nur https, z. B.{" "}
          <code>wiki.intranet.example</code> oder{" "}
          <code>*.intranet.example</code>)
        </span>
        <textarea
          className="ws-input ws-admin__hosts"
          rows={6}
          value={hosts}
          spellCheck={false}
          onChange={(event) => setHosts(event.target.value)}
        />
      </label>
      {configured.length > 0 && (
        <p className="ws-muted">
          Vom Betrieb fest erlaubt: {configured.join(", ")}
        </p>
      )}
      <label className="ws-toggle">
        <input
          type="checkbox"
          checked={external}
          onChange={(event) => setExternal(event.target.checked)}
        />
        Externe Dienste erlauben (YouTube, Vimeo, Figma, Google Drive und andere
        aus dem Internet)
      </label>
      <p className="ws-muted">
        Die eingebettete Seite muss das Einbetten selbst zulassen (ihre
        Content-Security-Policy bzw. X-Frame-Options).
      </p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="ws-dialog__actions">
        <Button variant="primary" disabled={saving} onClick={save}>
          {saving ? "Speichert …" : "Speichern"}
        </Button>
      </div>
    </section>
  );
};

/** E3: the company's fonts */
const FontsCard = () => {
  const [fonts, setFonts] = useState<CompanyFont[] | null>(null);
  const [family, setFamily] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const load = () =>
    adminApi
      .fonts()
      .then((result) => setFonts(result.fonts))
      .catch((error) => setMessage({ kind: "error", text: error.message }));

  useEffect(() => {
    load();
  }, []);

  const upload = async () => {
    if (!file) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const { font } = await adminApi.uploadFont(family.trim(), file);
      setMessage({
        kind: "info",
        text: `„${font.family}“ ist da. Im Editor ab dem nächsten Laden.`,
      });
      setFamily("");
      setFile(null);
      load();
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (font: CompanyFont) => {
    if (
      !window.confirm(
        `„${font.family}“ entfernen? Texte in dieser Schrift erscheinen danach in einer Ersatzschrift.`,
      )
    ) {
      return;
    }
    try {
      await adminApi.deleteFont(font.id);
      load();
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    }
  };

  return (
    <section className="ws-admin__card">
      <h3>Firmenschriften</h3>
      {/* previews of the fonts in the list */}
      {fonts && fonts.length > 0 && (
        <style>
          {fonts
            .map(
              (font) =>
                `@font-face { font-family: "ws-preview-${font.id}"; src: url("${font.url}") format("woff2"); }`,
            )
            .join("\n")}
        </style>
      )}
      <p className="ws-muted">
        Schriften des Unternehmens erscheinen bei allen im Schriftmenü des
        Editors und werden beim Export eingebettet. Bitte nur Schriften
        hochladen, deren Lizenz das erlaubt (Einbetten in Bilder und PDFs).
      </p>
      {fonts === null ? (
        <p className="ws-muted">Lade …</p>
      ) : fonts.length === 0 ? (
        <p className="ws-muted">Noch keine.</p>
      ) : (
        <ul className="ws-admin__fonts">
          {fonts.map((font) => (
            <li key={font.id}>
              <span
                className="ws-admin__font-preview"
                style={{ fontFamily: `"ws-preview-${font.id}", sans-serif` }}
              >
                {font.family}: Ä Ö Ü ß 0123 Quartalszahlen
              </span>
              <Button variant="ghost" onClick={() => remove(font)}>
                Entfernen
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="ws-admin__font-upload">
        <label className="ws-field">
          <span>Name im Schriftmenü</span>
          <input
            className="ws-input"
            value={family}
            maxLength={40}
            placeholder="z. B. Firma Sans"
            onChange={(event) => setFamily(event.target.value)}
          />
        </label>
        <label className="ws-field">
          <span>Datei (.ttf, .otf oder .woff2, höchstens 10 MB)</span>
          <input
            type="file"
            accept=".ttf,.otf,.woff2,font/ttf,font/otf,font/woff2"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
        </label>
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="ws-dialog__actions">
        <Button
          variant="primary"
          disabled={busy || !file || !family.trim()}
          onClick={upload}
        >
          {busy ? "Lädt hoch …" : "Hochladen"}
        </Button>
      </div>
    </section>
  );
};

export const EditorSection = ({ children }: { children?: ReactNode }) => (
  <div className="ws-admin__detail">
    <EmbedsCard />
    <FontsCard />
    {children}
  </div>
);
