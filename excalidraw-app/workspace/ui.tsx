/**
 * Intranet fork: small UI kit for the workspace (dashboard and the dialogs
 * the editor shows for workspace scenes). Styles: workspace.scss.
 */
import clsx from "clsx";
import { useEffect, useId, useRef } from "react";

import "./workspace.scss";

import type { ReactNode } from "react";

export const Dialog = ({
  title,
  onClose,
  children,
  footer,
  size = "regular",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "regular" | "wide";
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not(.ws-dialog__close)",
    );
    (first || panelRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="ws-theme ws-dialog__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={clsx("ws-dialog", `ws-dialog--${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // keep editor shortcuts from firing while typing in the dialog
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="ws-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="ws-dialog__close"
            aria-label="Schließen"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="ws-dialog__body">{children}</div>
        {footer && <div className="ws-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
};

export const Button = ({
  variant = "secondary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) => (
  <button
    type="button"
    {...props}
    className={clsx("ws-button", `ws-button--${variant}`, className)}
  />
);

export const Notice = ({
  kind = "info",
  children,
}: {
  kind?: "info" | "error";
  children: ReactNode;
}) => (
  <p className={clsx("ws-notice", `ws-notice--${kind}`)} role="status">
    {children}
  </p>
);

const AVATAR_COLORS = [
  "#5f3dc4",
  "#1971c2",
  "#0c8599",
  "#2f9e44",
  "#e8590c",
  "#c2255c",
  "#6741d9",
  "#1098ad",
];

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

export const Avatar = ({ id, name }: { id: string; name: string }) => {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return (
    <span
      className="ws-avatar"
      title={name}
      style={{ background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}
    >
      {initials(name)}
    </span>
  );
};

const relativeFormat = new Intl.RelativeTimeFormat("de", { numeric: "auto" });

/** "vor 5 Minuten", "gestern", ... */
export const formatRelative = (date: string | Date) => {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) {
    return "gerade eben";
  }
  if (abs < 3600) {
    return relativeFormat.format(Math.round(seconds / 60), "minute");
  }
  if (abs < 86400) {
    return relativeFormat.format(Math.round(seconds / 3600), "hour");
  }
  if (abs < 86400 * 30) {
    return relativeFormat.format(Math.round(seconds / 86400), "day");
  }
  return new Date(date).toLocaleDateString("de-DE");
};

export const ROLE_LABELS: Record<"viewer" | "editor" | "manager", string> = {
  viewer: "Kann ansehen",
  editor: "Kann bearbeiten",
  manager: "Verwaltet",
};
