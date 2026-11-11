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
   DATA_ENCRYPTION_KEY=ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE= \
   yarn dev
   ```

   Der Entwicklungs-Realm kennt `http://localhost:3001` bereits als Rücksprungadresse. Der Schlüssel ist derselbe Entwicklungsschlüssel wie im Compose-Stack, nur für lokale Daten.

3. App starten (Vite leitet `/api` und `/socket.io` an den Server weiter):

   ```bash
   yarn start
   ```

Nur am Frontend arbeiten, ohne Server und Login: `VITE_APP_DISABLE_AUTH=true` in `.env.development.local`. Dashboard, Live-Sitzungen und Teilen-Links gehen dann nicht; die App startet direkt im lokalen Editor.

## Tests

| Was | Befehl | Voraussetzung |
| --- | --- | --- |
| Editor und App (Upstream-Suite) | `yarn test:update` | – |
| Typen | `yarn test:typecheck`, `yarn --cwd excalidraw-server typecheck` | – |
| Server (Integration) | `yarn --cwd excalidraw-server test` | `TEST_DATABASE_URL` auf eine Wegwerf-Datenbank |
| Element-Logik für den Server | `yarn --cwd excalidraw-server build:elements` | – (läuft vor `dev`, `test`, `e2e` und `build` automatisch) |
| Browser Ende-zu-Ende | `yarn --cwd excalidraw-server e2e` | `yarn build:app:docker`, `TEST_DATABASE_URL`, Chromium für Playwright |

Die Server-Tests verwenden einen nachgebauten OpenID-Provider (`excalidraw-server/test/helpers/fakeOidc.ts`), der sich wie Keycloak verhält (Discovery, PKCE, Rollen in `realm_access`/`resource_access`, Back-Channel-Logout). Achtung: Die Tests leeren das Schema `public` der Testdatenbank.

Die Browser-Tests spielen mehrere Personen durch:

- Anmeldung, Zeichnen, Teilen-Link, Live-Sitzung mit Beitritt über den Raum-Link und Abmeldung
- Workspace: Collection anlegen und an eine Keycloak-Gruppe freigeben, Szene gemeinsam live bearbeiten, Zugriff für Außenstehende verweigert, Nur-Lese-Link ohne Werkzeugleiste, Dashboard mit Vorschaubild und Live-Anzeige
- eine lokale Zeichnung in den Workspace übernehmen
- API-Token im Dashboard anlegen, per API ein Diagramm zeichnen, eine API-Änderung live in zwei offenen Editoren, ein Kommentar, den eine Person mit Leserecht live sieht und beantwortet

Sie schlagen fehl, sobald die App eine Anfrage außerhalb der eigenen Origin stellt, die Content-Security-Policy etwas blockiert oder im Browser ein Fehler auftritt.

## Updates vom Original-Projekt übernehmen

Der Fork ändert den Editor-Kern nur an wenigen Stellen. Beim Mergen von `excalidraw/excalidraw` sind Konflikte vor allem hier zu erwarten:

- `excalidraw-app/`: `App.tsx`, `index.tsx`, `index.html`, `vite.config.mts`, `package.json`, `sentry.ts`, `app_constants.ts`, `collab/Collab.tsx`, `data/firebase.ts`, `data/index.ts`, `share/ShareDialog.tsx`, `components/{AppMainMenu,AppWelcomeScreen,AppFooter,AppSidebar,EncryptedIcon,TopErrorBoundary,AI}.tsx`
- Eigene Verzeichnisse ohne Gegenstück upstream (keine Konflikte, aber nach Upstream-Änderungen an `App.tsx` und `Collab.tsx` prüfen): `excalidraw-app/intranet/`, `excalidraw-app/workspace/`, `excalidraw-server/`, `deploy/`
- `excalidraw-server/elements/` nutzt die Element-Logik aus `packages/element` und `restoreElements` aus `packages/excalidraw/data/restore.ts`. Ändert sich deren API, meldet das `yarn test:typecheck` (die Datei ist dort eingebunden), die Server-Tests prüfen das Verhalten.
- Ändern sich die Schriften in `packages/excalidraw/fonts`, die Zeichenbreiten neu erzeugen: `yarn --cwd excalidraw-server font-metrics`.
- Editor-Kern (`packages/excalidraw`): `components/LibraryMenuBrowseButton.tsx`, `components/LibraryMenuHeaderContent.tsx`, `fonts/ExcalidrawFontFace.ts`, `vite-env.d.ts` – jeweils nur ein Schalter über eine leere Umgebungsvariable
- `scripts/woff2/woff2-vite-plugins.js` (Schriften lokal statt CDN)
- `.env.production`, `.env.development`, `.dockerignore`, `package.json`, `vitest.config.mts`

Entfernt wurden: Excalidraw+-Export, -Werbung und -Weiterleitung, Firebase, Simple Analytics, Sitemap, Social-Links. Neue Upstream-Features, die externe Dienste nutzen, fallen im Browser-Test auf.
