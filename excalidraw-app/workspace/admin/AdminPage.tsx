/**
 * Intranet fork: administration (/admin). App admins (Keycloak role
 * excalidraw-admin) see everything; workspace admins only the workspaces
 * they run.
 */
import clsx from "clsx";
import { useEffect, useState } from "react";

import { adminApi } from "../../intranet/adminApi";
import { logoUrl, useBranding } from "../../intranet/branding";
import { getCurrentUser } from "../../intranet/session";

import { Avatar, Notice } from "../ui";

import { AuditSection } from "./AuditSection";
import { BrandingSection } from "./BrandingSection";
import { PeopleSection } from "./PeopleSection";
import { WorkspacesSection } from "./WorkspacesSection";

import "./admin.scss";

type Tab = "workspaces" | "people" | "audit" | "branding" | "figures";

const TABS: { id: Tab; label: string; appAdminOnly: boolean }[] = [
  { id: "workspaces", label: "Workspaces", appAdminOnly: false },
  { id: "people", label: "Personen", appAdminOnly: true },
  { id: "audit", label: "Audit-Log", appAdminOnly: true },
  { id: "branding", label: "Branding", appAdminOnly: true },
  { id: "figures", label: "Kennzahlen", appAdminOnly: true },
];

const DESCRIPTIONS: Record<Tab, string> = {
  workspaces:
    "Wer welchen Workspace sieht und was dort erlaubt ist (Teilen, Links, Export, Papierkorb).",
  people:
    "Konten sperren, API-Tokens beenden und Personen aus Datenschutzgründen entfernen.",
  audit:
    "Anmeldungen, Freigaben, Exporte und Verwaltungsaktionen, nachvollziehbar und als CSV.",
  branding: "Name, Farbe, Logo und Links der App für alle.",
  figures: "Umfang und Wachstum der Installation.",
};

const FIGURES: { key: string; label: string; bytes?: boolean }[] = [
  { key: "users", label: "Personen (ohne entfernte)" },
  { key: "active_users_30d", label: "In den letzten 30 Tagen angemeldet" },
  { key: "workspaces", label: "Workspaces" },
  { key: "team_collections", label: "Team-Collections" },
  { key: "scenes", label: "Szenen" },
  { key: "scenes_in_trash", label: "Szenen im Papierkorb" },
  { key: "scene_bytes", label: "Gespeicherte Zeichnungen", bytes: true },
  { key: "versions", label: "Gespeicherte Versionen" },
  { key: "version_bytes", label: "Speicher für Versionen", bytes: true },
  { key: "comment_threads", label: "Kommentar-Threads" },
  { key: "active_tokens", label: "Gültige API-Tokens" },
  { key: "events", label: "Einträge im Audit-Log" },
];

const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString("de", {
    maximumFractionDigits: unit ? 1 : 0,
  })} ${units[unit]}`;
};

const FiguresSection = () => {
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .stats()
      .then(setStats)
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return <Notice kind="error">{error}</Notice>;
  }
  if (!stats) {
    return <p className="ws-muted">Lade …</p>;
  }
  const retention = stats.retention || {};
  return (
    <div className="ws-admin__detail">
      <table className="ws-table ws-admin__figures" aria-label="Kennzahlen">
        <tbody>
          {FIGURES.map((figure) => (
            <tr key={figure.key}>
              <th scope="row">{figure.label}</th>
              <td>
                {figure.bytes
                  ? formatBytes(Number(stats[figure.key] || 0))
                  : Number(stats[figure.key] || 0).toLocaleString("de")}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Bilder und Dateien</th>
            <td>
              {stats.blobs?.driver === "s3"
                ? "im S3-Speicher"
                : `${Number(stats.blobs?.count || 0).toLocaleString(
                    "de",
                  )} Dateien, ${formatBytes(Number(stats.blobs?.bytes || 0))}`}
            </td>
          </tr>
        </tbody>
      </table>
      <section className="ws-admin__card">
        <h3>Aufbewahrung</h3>
        <ul className="ws-admin__facts">
          <li>
            Papierkorb (Standard für neue Workspaces): {retention.trashDays}{" "}
            Tage
          </li>
          <li>
            Versionen: höchstens eine alle {retention.versionIntervalMinutes}{" "}
            Minuten, nach zwei Tagen eine pro Tag, gelöscht nach{" "}
            {retention.versionDays} Tagen
          </li>
          <li>Audit-Log: {retention.auditDays} Tage</li>
          <li>„Zuletzt geöffnet“: {retention.visitDays} Tage</li>
        </ul>
        <p className="ws-muted">
          Einstellbar über Umgebungsvariablen des Servers (siehe Betriebs-
          dokumentation). Metriken für Prometheus liefert der Server auf seinem
          Metrik-Port.
        </p>
      </section>
    </div>
  );
};

export const AdminPage = () => {
  const user = getCurrentUser();
  const branding = useBranding();
  const isAppAdmin = !!user?.isAdmin;
  const tabs = TABS.filter((tab) => isAppAdmin || !tab.appAdminOnly);
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return tabs.find((item) => item.id === requested)?.id || "workspaces";
  });

  useEffect(() => {
    document.title = `Verwaltung · ${branding.name}`;
  }, [branding.name]);

  const select = (next: Tab) => {
    setTab(next);
    window.history.replaceState(
      null,
      "",
      next === "workspaces" ? "/admin" : `/admin?tab=${next}`,
    );
  };

  const logo = logoUrl(branding);
  const current = tabs.find((item) => item.id === tab) || tabs[0];

  return (
    <div className="ws-theme ws-dashboard ws-admin">
      <header className="ws-header">
        <a className="ws-brand" href="/">
          {logo && (
            <span className="ws-brand__logo">
              <img src={logo} alt="" />
            </span>
          )}
          {branding.name}
        </a>
        <span className="ws-admin__badge">Verwaltung</span>
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

      <div className="ws-layout">
        <nav className="ws-sidebar" aria-label="Verwaltung">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={clsx("ws-nav-item", item.id === tab && "is-active")}
              aria-current={item.id === tab ? "page" : undefined}
              onClick={() => select(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <main className="ws-main">
          <div className="ws-main__header">
            <div>
              <h1>{current.label}</h1>
              <p className="ws-muted">{DESCRIPTIONS[current.id]}</p>
            </div>
          </div>
          {current.id === "workspaces" && <WorkspacesSection />}
          {current.id === "people" && <PeopleSection />}
          {current.id === "audit" && <AuditSection />}
          {current.id === "branding" && <BrandingSection />}
          {current.id === "figures" && <FiguresSection />}
        </main>
      </div>
    </div>
  );
};
