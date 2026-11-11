# Entwicklung

## Lokal starten

Am einfachsten mit dem Compose-Stack (siehe [README](./README.md#schnellstart-zum-ausprobieren)). Für die Arbeit am Code laufen Server und App getrennt mit Hot Reload:

1. PostgreSQL und Keycloak aus dem Compose-Stack starten:

   ```bash
   docker compose -f deploy/compose/docker-compose.yml up postgres keycloak
   ```

2. Server starten (lauscht auf 8080, Logins kehren zum Vite-Dev-Server zurück):

   ```bash
   cd excalidraw-server
   PUBLIC_URL=http://localhost:3001 \
   DATABASE_URL=postgres://excalidraw:excalidraw@localhost:5432/excalidraw \
   OIDC_ISSUER_URL=http://localhost:8080/realms/intranet \
   OIDC_CLIENT_ID=excalidraw OIDC_CLIENT_SECRET=dev-secret-change-me \
   OIDC_ALLOW_INSECURE_HTTP=true \
   yarn dev
   ```

   Der Entwicklungs-Realm kennt `http://localhost:3001` bereits als Rücksprungadresse.

3. App starten (Vite leitet `/api` und `/socket.io` an den Server weiter):

   ```bash
   yarn start
   ```

Nur am Frontend arbeiten, ohne Server und Login: `VITE_APP_DISABLE_AUTH=true` in `.env.development.local`. Live-Sitzungen und Teilen-Links gehen dann nicht.

## Tests

| Was | Befehl | Voraussetzung |
| --- | --- | --- |
| Editor und App (Upstream-Suite) | `yarn test:update` | – |
| Typen | `yarn test:typecheck`, `yarn --cwd excalidraw-server typecheck` | – |
| Server (Integration) | `yarn --cwd excalidraw-server test` | `TEST_DATABASE_URL` auf eine Wegwerf-Datenbank |
| Browser Ende-zu-Ende | `yarn --cwd excalidraw-server e2e` | `yarn build:app:docker`, `TEST_DATABASE_URL`, Chromium für Playwright |

Die Server-Tests verwenden einen nachgebauten OpenID-Provider (`excalidraw-server/test/helpers/fakeOidc.ts`), der sich wie Keycloak verhält (Discovery, PKCE, Rollen in `realm_access`/`resource_access`, Back-Channel-Logout). Achtung: Die Tests leeren das Schema `public` der Testdatenbank.

Der Browser-Test spielt zwei Personen durch: Anmeldung, Zeichnen, Teilen-Link, Live-Sitzung mit Beitritt über den Raum-Link und Abmeldung. Er schlägt fehl, sobald die App eine Anfrage außerhalb der eigenen Origin stellt oder die Content-Security-Policy etwas blockiert.

## Updates vom Original-Projekt übernehmen

Der Fork ändert den Editor-Kern nur an wenigen Stellen. Beim Mergen von `excalidraw/excalidraw` sind Konflikte vor allem hier zu erwarten:

- `excalidraw-app/`: `App.tsx`, `index.tsx`, `index.html`, `vite.config.mts`, `package.json`, `sentry.ts`, `app_constants.ts`, `collab/Collab.tsx`, `data/firebase.ts`, `data/index.ts`, `share/ShareDialog.tsx`, `components/{AppMainMenu,AppWelcomeScreen,AppFooter,AppSidebar,EncryptedIcon,TopErrorBoundary,AI}.tsx`
- Editor-Kern (`packages/excalidraw`): `components/LibraryMenuBrowseButton.tsx`, `components/LibraryMenuHeaderContent.tsx`, `fonts/ExcalidrawFontFace.ts`, `vite-env.d.ts` – jeweils nur ein Schalter über eine leere Umgebungsvariable
- `scripts/woff2/woff2-vite-plugins.js` (Schriften lokal statt CDN)
- `.env.production`, `.env.development`, `.dockerignore`, `package.json`, `vitest.config.mts`

Entfernt wurden: Excalidraw+-Export, -Werbung und -Weiterleitung, Firebase, Simple Analytics, Sitemap, Social-Links. Neue Upstream-Features, die externe Dienste nutzen, fallen im Browser-Test auf.
