/**
 * Intranet fork: the company's branding (B8), set by app admins under
 * /admin: name, accent colour, logo and links (help, data protection, ...).
 *
 * The accent colour goes into CSS variables that workspace.scss reads
 * (--brand-*), so it applies to the dashboard, the dialogs and the admin
 * page in light and dark mode.
 */
import { useEffect, useState } from "react";

export interface Branding {
  name: string;
  primaryColor: string | null;
  links: { label: string; url: string }[];
  /** version of the uploaded logo, null = built-in logo */
  logo: number | null;
}

export const DEFAULT_BRANDING: Branding = {
  name: "Excalidraw",
  primaryColor: null,
  links: [],
  logo: null,
};

let loading: Promise<Branding> | null = null;
let current: Branding = DEFAULT_BRANDING;
const listeners = new Set<(branding: Branding) => void>();

const toRgb = (hex: string) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** mix a colour with another one (amount 0..1 of `other`) */
const mix = (hex: string, other: string, amount: number) => {
  const a = toRgb(hex);
  const b = toRgb(other);
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

const VARIABLES = [
  "--brand-primary",
  "--brand-primary-hover",
  "--brand-primary-soft",
  "--brand-primary-dark",
  "--brand-primary-dark-hover",
  "--brand-primary-dark-soft",
];

export const applyBrandColor = (color: string | null) => {
  const style = document.documentElement.style;
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    VARIABLES.forEach((name) => style.removeProperty(name));
    return;
  }
  const values = [
    color,
    mix(color, "#000000", 0.12),
    mix(color, "#ffffff", 0.85),
    mix(color, "#ffffff", 0.35),
    mix(color, "#ffffff", 0.5),
    mix(color, "#121216", 0.7),
  ];
  VARIABLES.forEach((name, index) => style.setProperty(name, values[index]));
};

const publish = (branding: Branding) => {
  current = branding;
  applyBrandColor(branding.primaryColor);
  listeners.forEach((listener) => listener(branding));
};

/** load once per page; falls back to the defaults */
export const loadBranding = (): Promise<Branding> => {
  if (!loading) {
    loading = fetch("/api/branding", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : DEFAULT_BRANDING))
      .then((branding: Branding) => ({ ...DEFAULT_BRANDING, ...branding }))
      .catch(() => DEFAULT_BRANDING)
      .then((branding) => {
        publish(branding);
        return branding;
      });
  }
  return loading;
};

/** after the admin page saved a change */
export const setBranding = (branding: Branding) => {
  loading = Promise.resolve(branding);
  publish(branding);
};

export const logoUrl = (branding: Branding) =>
  branding.logo ? `/api/branding/logo?v=${branding.logo}` : null;

export const useBranding = () => {
  const [branding, setState] = useState<Branding>(current);
  useEffect(() => {
    listeners.add(setState);
    loadBranding();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return branding;
};
