import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";
import { BootError } from "./intranet/BootError";
import { bootstrapSession } from "./intranet/session";

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();

// intranet fork: the editor starts only with a valid company login
bootstrapSession().then((result) => {
  if (result.status === "redirecting") {
    return;
  }
  if (result.status === "error") {
    root.render(<BootError message={result.message} />);
    return;
  }
  root.render(
    <StrictMode>
      <ExcalidrawApp />
    </StrictMode>,
  );
});
