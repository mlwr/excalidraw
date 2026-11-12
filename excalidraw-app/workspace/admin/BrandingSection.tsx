/**
 * Intranet fork, administration: branding (B8). Name, accent colour, logo
 * and links (e.g. help, data protection notice) for everyone in the app.
 */
import { useEffect, useRef, useState } from "react";

import { adminApi } from "../../intranet/adminApi";
import {
  applyBrandColor,
  logoUrl,
  setBranding,
  useBranding,
} from "../../intranet/branding";

import { Button, Notice } from "../ui";

import type { Branding } from "../../intranet/branding";

const MAX_LINKS = 6;
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPES = ["image/png", "image/svg+xml", "image/webp"];
const DEFAULT_COLOR = "#6965db";

export const BrandingSection = () => {
  const branding = useBranding();
  const [name, setName] = useState(branding.name);
  const [color, setColor] = useState<string | null>(branding.primaryColor);
  const [links, setLinks] = useState(branding.links);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // the saved values arrive after the first render
  useEffect(() => {
    setName(branding.name);
    setColor(branding.primaryColor);
    setLinks(branding.links);
  }, [branding]);

  // preview the colour while choosing; leaving the page shows the saved one
  const savedColor = useRef(branding.primaryColor);
  savedColor.current = branding.primaryColor;
  useEffect(() => {
    applyBrandColor(color);
  }, [color]);
  useEffect(() => () => applyBrandColor(savedColor.current), []);

  const done = (next: Branding, text: string) => {
    setBranding(next);
    setMessage({ kind: "info", text });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      done(
        await adminApi.saveBranding({
          name,
          primaryColor: color,
          links: links.filter((link) => link.label.trim() || link.url.trim()),
        }),
        "Gespeichert. Die Änderungen sehen alle beim nächsten Laden der Seite.",
      );
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setMessage(null);
    if (!LOGO_TYPES.includes(file.type) || file.size > MAX_LOGO_BYTES) {
      setMessage({
        kind: "error",
        text: "Das Logo muss PNG, SVG oder WebP sein und höchstens 512 KB groß.",
      });
      return;
    }
    try {
      done(await adminApi.uploadLogo(file), "Logo gespeichert.");
    } catch (error: any) {
      setMessage({ kind: "error", text: error.message });
    }
  };

  const logo = logoUrl(branding);

  return (
    <div className="ws-admin__detail">
      <section className="ws-admin__card">
        <h3>Name und Farbe</h3>
        <label className="ws-field">
          <span>Name der App</span>
          <input
            className="ws-input"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="ws-field">
          <span>Akzentfarbe</span>
          <div className="ws-admin__color">
            <input
              type="color"
              aria-label="Akzentfarbe"
              value={color || DEFAULT_COLOR}
              onChange={(event) => setColor(event.target.value)}
            />
            <code>{color || "Standard"}</code>
            {color && (
              <Button variant="ghost" onClick={() => setColor(null)}>
                Standardfarbe
              </Button>
            )}
          </div>
        </div>

        <h3>Links</h3>
        <p className="ws-muted">
          Erscheinen in der Übersicht, z. B. Hilfe, Datenschutzhinweise oder
          Ansprechpartner.
        </p>
        {links.map((link, index) => (
          <div className="ws-admin__link-row" key={index}>
            <input
              className="ws-input"
              placeholder="Bezeichnung"
              aria-label={`Bezeichnung von Link ${index + 1}`}
              value={link.label}
              maxLength={40}
              onChange={(event) =>
                setLinks(
                  links.map((item, i) =>
                    i === index ? { ...item, label: event.target.value } : item,
                  ),
                )
              }
            />
            <input
              className="ws-input"
              placeholder="https://intranet.example/hilfe"
              aria-label={`Adresse von Link ${index + 1}`}
              value={link.url}
              onChange={(event) =>
                setLinks(
                  links.map((item, i) =>
                    i === index ? { ...item, url: event.target.value } : item,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              aria-label={`Link ${index + 1} entfernen`}
              onClick={() => setLinks(links.filter((_, i) => i !== index))}
            >
              ×
            </Button>
          </div>
        ))}
        {links.length < MAX_LINKS && (
          <Button onClick={() => setLinks([...links, { label: "", url: "" }])}>
            Link hinzufügen
          </Button>
        )}

        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <div className="ws-dialog__actions">
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? "Speichert …" : "Speichern"}
          </Button>
        </div>
      </section>

      <section className="ws-admin__card">
        <h3>Logo</h3>
        <div className="ws-admin__logo">
          {logo ? (
            <img src={logo} alt="Aktuelles Logo" />
          ) : (
            <p className="ws-muted">Es wird das Standard-Logo gezeigt.</p>
          )}
        </div>
        <div className="ws-main__actions">
          <Button onClick={() => fileRef.current?.click()}>
            Logo hochladen …
          </Button>
          {logo && (
            <Button
              variant="ghost"
              onClick={async () =>
                done(await adminApi.removeLogo(), "Logo entfernt.")
              }
            >
              Logo entfernen
            </Button>
          )}
        </div>
        <p className="ws-muted">PNG, SVG oder WebP, höchstens 512 KB.</p>
        <input
          ref={fileRef}
          type="file"
          accept={LOGO_TYPES.join(",")}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              upload(file);
            }
          }}
        />
      </section>
    </div>
  );
};
