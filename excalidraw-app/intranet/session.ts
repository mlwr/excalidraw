/**
 * Intranet fork: who is logged in and what the server allows.
 *
 * The app only starts after `bootstrapSession()` confirmed a Keycloak session
 * with the backend (`/api/auth/me`). Without one, the browser is sent to the
 * login. The URL fragment (which can contain end-to-end encryption keys) is
 * kept in sessionStorage and never sent to the server.
 */

export interface IntranetUser {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  isAdmin: boolean;
}

export interface RuntimeConfig {
  maxFileSizeBytes: number;
  maxImageDimension: number;
  ai: { enabled: boolean };
  libraries: { browseUrl: string | null };
  workspace: { enabled: boolean };
  /** REST API and MCP server with personal API tokens */
  api: { enabled: boolean; mcpEnabled: boolean };
}

export type BootstrapResult =
  | { status: "authenticated" }
  | { status: "offline" }
  | { status: "redirecting" }
  | { status: "disabled" }
  | { status: "error"; message: string };

const DEFAULT_CONFIG: RuntimeConfig = {
  maxFileSizeBytes: 4 * 1024 * 1024,
  maxImageDimension: 1440,
  ai: { enabled: false },
  libraries: { browseUrl: null },
  workspace: { enabled: false },
  api: { enabled: false, mcpEnabled: false },
};

const RETURN_HASH_KEY = "excalidraw-intranet-return-hash";
const IDENTITY_CACHE_KEY = "excalidraw-intranet-identity";

let currentUser: IntranetUser | null = null;
let runtimeConfig: RuntimeConfig = DEFAULT_CONFIG;

export const getCurrentUser = () => currentUser;

export const getRuntimeConfig = () => runtimeConfig;

/** upload limit for encoded (compressed + encrypted) files */
export const getMaxFileUploadBytes = () => runtimeConfig.maxFileSizeBytes;

/**
 * Limits for images inserted into the editor. Encoded files are about a third
 * larger than the original image (base64), so the original must stay below
 * the server's upload limit with some margin.
 */
export const getImageOptions = () => ({
  maxFileSizeBytes: Math.floor(runtimeConfig.maxFileSizeBytes * 0.7),
  maxWidthOrHeight: runtimeConfig.maxImageDimension,
});

const applyIdentity = (user: IntranetUser, config: Partial<RuntimeConfig>) => {
  currentUser = user;
  runtimeConfig = { ...DEFAULT_CONFIG, ...config };
};

const readCachedIdentity = (): {
  user: IntranetUser;
  config: Partial<RuntimeConfig>;
} | null => {
  try {
    const raw = localStorage.getItem(IDENTITY_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeCachedIdentity = (
  value: { user: IntranetUser; config: Partial<RuntimeConfig> } | null,
) => {
  try {
    if (value) {
      localStorage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(IDENTITY_CACHE_KEY);
    }
  } catch {
    // storage may be unavailable (private mode); offline start then won't work
  }
};

/** send the browser to the Keycloak login and come back to this page */
export const redirectToLogin = () => {
  try {
    if (window.location.hash) {
      sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash);
    }
  } catch {
    // without sessionStorage a room/share link must be opened again
  }
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(
    `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
};

const restoreReturnHash = () => {
  try {
    const hash = sessionStorage.getItem(RETURN_HASH_KEY);
    sessionStorage.removeItem(RETURN_HASH_KEY);
    if (hash && !window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}${hash}`,
      );
    }
  } catch {
    // nothing to restore
  }
};

export const bootstrapSession = async (): Promise<BootstrapResult> => {
  if (import.meta.env.VITE_APP_DISABLE_AUTH === "true") {
    // frontend-only development without a backend
    return { status: "disabled" };
  }

  let response: Response;
  try {
    response = await fetch("/api/auth/me", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    // network down: allow working offline with locally stored drawings
    const cached = readCachedIdentity();
    if (cached) {
      applyIdentity(cached.user, cached.config);
      return { status: "offline" };
    }
    return {
      status: "error",
      message: "Der Excalidraw-Server ist nicht erreichbar.",
    };
  }

  if (response.status === 401) {
    redirectToLogin();
    return { status: "redirecting" };
  }
  if (!response.ok) {
    return {
      status: "error",
      message: `Der Excalidraw-Server antwortet mit Fehler ${response.status}.`,
    };
  }

  const body = (await response.json()) as {
    user: IntranetUser;
    config: Partial<RuntimeConfig>;
  };
  applyIdentity(body.user, body.config);
  writeCachedIdentity(body);
  restoreReturnHash();
  return { status: "authenticated" };
};

/**
 * End the app session and the Keycloak session. Locally stored drawings stay
 * in the browser, like on excalidraw.com.
 */
export const logout = async () => {
  writeCachedIdentity(null);
  let redirectUrl = "/";
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (response.ok) {
      redirectUrl = (await response.json()).redirectUrl || "/";
    }
  } catch {
    // fall through to the start page, which asks for a new login
  }
  window.location.assign(redirectUrl);
};
