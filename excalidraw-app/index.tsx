import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import { BackendError } from "./intranet/api";
import { BootError } from "./intranet/BootError";
import { getRoute, scenePath } from "./intranet/routes";
import { bootstrapSession, getRuntimeConfig } from "./intranet/session";
import { workspaceApi } from "./intranet/workspaceApi";
import { setActiveScene } from "./intranet/activeScene";

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();

const renderEditor = async () => {
  const { default: ExcalidrawApp } = await import("./App");
  root.render(
    <StrictMode>
      <ExcalidrawApp />
    </StrictMode>,
  );
};

const renderDashboard = async () => {
  const { Dashboard } = await import("./workspace/Dashboard");
  root.render(
    <StrictMode>
      <Dashboard />
    </StrictMode>,
  );
};

const renderAdmin = async () => {
  const { AdminPage } = await import("./workspace/admin/AdminPage");
  root.render(
    <StrictMode>
      <AdminPage />
    </StrictMode>,
  );
};

const dashboardLink = { href: "/", label: "Zur Übersicht" };

const start = async () => {
  // intranet fork: the app starts only with a valid company login
  const session = await bootstrapSession();
  if (session.status === "redirecting") {
    return;
  }
  if (session.status === "error") {
    root.render(<BootError message={session.message} />);
    return;
  }

  const route = getRoute();
  const workspaceAvailable =
    session.status === "authenticated" && getRuntimeConfig().workspace.enabled;

  // offline (or without a workspace) only the browser-local editor works
  if (!workspaceAvailable || route.kind === "local") {
    return renderEditor();
  }

  if (route.kind === "readLink") {
    try {
      const { sceneId } = await workspaceApi.resolveReadLink(route.token);
      window.location.replace(scenePath(sceneId));
    } catch (error) {
      root.render(
        <BootError
          title="Link ungültig"
          message="Dieser Link ist nicht mehr gültig oder die Szene wurde gelöscht."
          link={dashboardLink}
        />,
      );
    }
    return;
  }

  if (route.kind === "admin") {
    // the server decides what each admin may see; others get the dashboard
    return renderAdmin();
  }

  if (route.kind === "scene") {
    try {
      const { scene, key } = await workspaceApi.openScene(route.sceneId);
      setActiveScene({ ...scene, key });
    } catch (error) {
      const notFound = error instanceof BackendError && error.status === 404;
      root.render(
        <BootError
          title={notFound ? "Szene nicht gefunden" : "Szene nicht ladbar"}
          message={
            notFound
              ? "Die Szene existiert nicht (mehr) oder du hast keinen Zugriff. Bitte die Person, die sie angelegt hat, sie mit dir zu teilen."
              : (error as Error).message
          }
          link={dashboardLink}
        />,
      );
      return;
    }
    return renderEditor();
  }

  return renderDashboard();
};

start();
