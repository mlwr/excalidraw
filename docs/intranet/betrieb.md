# Betrieb

## 1. Image bauen

Das Image enthält die gebaute App und den Server (eine Datei, keine `node_modules`). Gebaut wird im Wurzelverzeichnis des Repos:

```bash
docker build -f deploy/docker/Dockerfile -t registry.intranet.example/excalidraw-intranet:0.1.0 .
```

Ohne Internetzugang im Build zeigen Basis-Images und npm auf interne Spiegel:

```bash
docker build -f deploy/docker/Dockerfile \
  --build-arg BUILD_IMAGE=registry.intranet.example/node:24-bookworm-slim \
  --build-arg RUNTIME_IMAGE=registry.intranet.example/node:24-bookworm-slim \
  --build-arg NPM_REGISTRY=https://nexus.intranet.example/repository/npm/ \
  -t registry.intranet.example/excalidraw-intranet:0.1.0 .
```

Der Container läuft als Benutzer `node` (UID 1000) auf Port 8080 und braucht kein beschreibbares Dateisystem.

## 2. Keycloak einrichten

In der Admin-Konsole von Keycloak im gewünschten Realm:

1. **Clients → Create client**: Typ _OpenID Connect_, Client-ID `excalidraw`.
2. **Capability config**: _Client authentication_ an, _Standard flow_ an, _Direct access grants_ aus.
3. **Login settings** (Beispiel-Domain ersetzen):
   - Valid redirect URIs: `https://excalidraw.intranet.example/api/auth/callback`
   - Valid post logout redirect URIs: `https://excalidraw.intranet.example/*`
   - Web origins: `https://excalidraw.intranet.example`
4. **Advanced → Proof Key for Code Exchange**: `S256`.
5. **Logout settings**: _Front channel logout_ aus, _Backchannel logout URL_ `https://excalidraw.intranet.example/api/auth/backchannel-logout` (muss von Keycloak aus erreichbar sein), _Backchannel logout session required_ an.
6. **Credentials**: Client-Secret kopieren (für das Kubernetes-Secret).
7. **Roles** (Client-Rollen): `excalidraw-admin` und `excalidraw-user` anlegen und Gruppen zuweisen, z. B. allen Mitarbeitenden `excalidraw-user`.
8. **Gruppen im Token**: _Client scopes → excalidraw-dedicated → Add mapper → By configuration → Group Membership_, Token Claim Name `groups`, _Full group path_ an, in ID-Token, Access-Token und Userinfo.

Soll nur ein Teil der Belegschaft Zugriff haben, `OIDC_REQUIRED_ROLE=excalidraw-user` setzen. Wer die Rolle nicht hat, sieht nach dem Login einen Hinweis statt der App.

Sollen nur bestimmte Personen API-Tokens für Skripte und KI-Assistenten bekommen, eine weitere Client-Rolle (z. B. `excalidraw-api`) anlegen, zuweisen und im Chart `api.requiredRole: excalidraw-api` setzen. Rollen werden bei der Anmeldung übernommen: Wer die Rolle verliert, kann seine Tokens nach dem nächsten Login nicht mehr benutzen.

## 3. Mit Helm installieren

Secrets vorab anlegen (empfohlen statt Klartext in den Values):

```bash
kubectl create secret generic excalidraw-oidc \
  --from-literal=oidc-client-secret='<Client-Secret aus Keycloak>'
kubectl create secret generic excalidraw-db \
  --from-literal=database-url='postgres://excalidraw:<Passwort>@postgres.db.svc:5432/excalidraw?sslmode=require'
kubectl create secret generic excalidraw-encryption \
  --from-literal=data-encryption-key="$(openssl rand -base64 32)"
kubectl create secret generic excalidraw-s3 \
  --from-literal=s3-access-key-id='<Access Key>' \
  --from-literal=s3-secret-access-key='<Secret Key>'
```

> **Wichtig:** Den Wert von `data-encryption-key` zusätzlich getrennt von den Datenbank-Backups sichern (z. B. im Passwort-Tresor des Betriebs). Ohne ihn lassen sich gespeicherte Szenen nicht mehr entschlüsseln; ein neuer Schlüssel macht alle bestehenden Szenen unlesbar.

```bash
kubectl get secret excalidraw-encryption -o jsonpath='{.data.data-encryption-key}' | base64 -d
```

`values-intranet.yaml`:

```yaml
image:
  repository: registry.intranet.example/excalidraw-intranet
  tag: "0.1.0"

publicUrl: https://excalidraw.intranet.example

oidc:
  issuerUrl: https://sso.intranet.example/realms/company
  clientId: excalidraw
  existingSecret: excalidraw-oidc
  requiredRole: excalidraw-user

database:
  existingSecret: excalidraw-db

encryption:
  existingSecret: excalidraw-encryption

# Bilder und Vorschaubilder im eigenen S3-Bucket
storage:
  driver: s3
  s3:
    endpoint: https://s3.intranet.example
    bucket: excalidraw
    existingSecret: excalidraw-s3

ingress:
  className: nginx
  tls:
    secretName: excalidraw-tls

# interne CA für TLS zu Keycloak, PostgreSQL und S3
extraCaCerts:
  configMap: corporate-ca
  key: ca.crt
```

```bash
helm upgrade --install excalidraw deploy/helm/excalidraw -f values-intranet.yaml
```

Hinweise:

- Die Datenbank wird beim Start automatisch migriert (`AUTO_MIGRATE`); mehrere Pods sperren sich dabei gegenseitig.
- Bei mehr als einem Pod schaltet das Chart `REALTIME_CLUSTER` ein, damit Live-Sitzungen über Pods hinweg funktionieren. Websockets brauchen am Ingress lange Timeouts (sind für ingress-nginx voreingestellt).
- `postgresql.enabled: true` startet eine einfache Datenbank im Cluster, nur für Testumgebungen.
- Szenen (verschlüsselt) liegen immer in PostgreSQL, Bilder und Vorschaubilder je nach `storage.driver` in PostgreSQL (Standard) oder im S3-Bucket. Mit eigenem S3 ist `s3` die bessere Wahl: Bilder sind bis zu 25 MB groß und blähen sonst Datenbank und Backups auf. Ein Wechsel später verschiebt bestehende Bilder nicht.
- Ohne `encryption.key` oder `encryption.existingSecret` bricht `helm install` mit einer Meldung ab.
- REST-API und MCP-Server sind eingeschaltet (`api.enabled`, `api.mcpEnabled`) und laufen über denselben Ingress wie die App (`/api/v1`, `/mcp`). Clients außerhalb des Browsers brauchen also nur die interne CA, keinen weiteren Endpunkt.

## 4. Konfiguration (Server)

Alle Einstellungen sind Umgebungsvariablen; das Chart setzt sie aus den Values. Fehlen Pflichtangaben, startet der Server nicht und nennt alle fehlenden Variablen.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PUBLIC_URL` | – (Pflicht) | Externe Adresse, nur Origin, z. B. `https://excalidraw.intranet.example` |
| `DATABASE_URL` | – (Pflicht) | PostgreSQL-Verbindung (`postgres://…`, `?sslmode=require` für TLS) |
| `DATABASE_POOL_SIZE` | `10` | Datenbankverbindungen pro Pod |
| `AUTO_MIGRATE` | `true` | Schema beim Start aktualisieren |
| `DATA_ENCRYPTION_KEY` | – (Pflicht) | Hauptschlüssel für die Szenen-Schlüssel: 32 Zufallsbytes in Base64 (`openssl rand -base64 32`), getrennt sichern |
| `OIDC_ISSUER_URL` | – (Pflicht) | Realm-URL, z. B. `https://sso.intranet.example/realms/company` |
| `OIDC_CLIENT_ID` | – (Pflicht) | Client-ID in Keycloak |
| `OIDC_CLIENT_SECRET` | – | Secret des vertraulichen Clients |
| `OIDC_SCOPES` | `openid profile email` | Angefragte Scopes |
| `OIDC_ROLES_CLAIMS` | Realm- und Client-Rollen | Claim-Pfade mit Rollen, durch Komma getrennt |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim mit den Gruppen |
| `OIDC_ADMIN_ROLE` | `excalidraw-admin` | Rolle für Admin-Rechte |
| `OIDC_REQUIRED_ROLE` | leer | Rolle, ohne die niemand hineinkommt; leer = alle |
| `OIDC_POST_LOGOUT_REDIRECT_URL` | `PUBLIC_URL` | Ziel nach dem Abmelden |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | Keycloak über http (nur Entwicklung) |
| `SESSION_TTL_HOURS` | `10` | Lebensdauer einer Sitzung |
| `SESSION_COOKIE_NAME` | `excalidraw_session` | Name des Sitzungs-Cookies |
| `STORAGE_DRIVER` | `postgres` | `postgres` oder `s3` für Bilder und Vorschaubilder |
| `S3_ENDPOINT`, `S3_BUCKET` | – | S3-Ziel (bei `s3` Pflicht) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | – | S3-Zugang (bei `s3` Pflicht) |
| `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | `us-east-1`, `true`, leer | S3-Details |
| `MAX_FILE_SIZE_MB` | `25` | Größte Bilddatei (verschlüsselt) |
| `MAX_IMAGE_DIMENSION` | `3840` | Längste Bildseite in Pixeln (4K) |
| `MAX_SCENE_SIZE_MB`, `MAX_SHARE_LINK_SIZE_MB` | `50` | Größte Szene bzw. Teilen-Link |
| `REALTIME_CLUSTER` | `false` | Live-Sitzungen über mehrere Pods (PostgreSQL) |
| `REALTIME_MAX_PAYLOAD_MB` | `50` | Größte Websocket-Nachricht |
| `STATIC_DIR` | im Image gesetzt | Verzeichnis der gebauten App; leer = nur API |
| `CSP_FRAME_SRC` | leer | Zusätzliche Origins für eingebettete Inhalte |
| `CSP_FRAME_ANCESTORS` | leer | Origins, die Excalidraw einbetten dürfen |
| `LIBRARY_BROWSE_URL` | leer | Interner Bibliothekskatalog (später) |
| `API_ENABLED` | `true` | REST-API unter `/api/v1` und API-Tokens |
| `MCP_ENABLED` | `true` | MCP-Server unter `/mcp` (braucht die API) |
| `API_TOKEN_MAX_DAYS` | `365` | Längste Gültigkeit eines Tokens in Tagen |
| `API_REQUIRED_ROLE` | leer | Keycloak-Rolle, ohne die niemand Tokens anlegen oder benutzen darf; leer = alle (Admins dürfen immer) |
| `API_RATE_LIMIT_PER_MINUTE` | `300` | Anfragen pro Token und Minute |
| `TRUST_PROXY` | `1` | Vertrauenswürdige Proxy-Hops vor dem Pod |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Adresse des Servers |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_EXTRA_CA_CERTS` | – | PEM-Datei der internen CA (Node.js-Standard) |

## 5. Laufender Betrieb

- **Health**: `GET /healthz` (Prozess lebt), `GET /readyz` (Datenbank und Speicher erreichbar). Ein Ausfall von Keycloak nimmt Pods nicht aus dem Dienst; laufende Sitzungen arbeiten weiter, neue Anmeldungen schlagen fehl.
- **Logs**: JSON-Zeilen auf stdout, Cookies und Authorization-Header werden geschwärzt.
- **Backup**: PostgreSQL (`pg_dump`), bei `STORAGE_DRIVER=s3` zusätzlich der Bucket, und einmalig der `DATA_ENCRYPTION_KEY` an einem getrennten Ort. Nur alle drei zusammen ergeben eine lesbare Wiederherstellung; Dump und Bucket allein enthalten nur Chiffretext.
- **Gelöschte Szenen** sind vorerst nur ausgeblendet (`deleted_at`) und bleiben in der Datenbank. Papierkorb und endgültiges Löschen folgen mit W5 und S3 in Phase 4. Gleiches gilt für gelöschte Kommentare.
- **API-Tokens** einer Person widerrufen: Die Person selbst im Dashboard; im Notfall `update api_tokens set revoked_at = now() where user_id = '<id>';`.
- **Updates**: Image-Tag erhöhen und `helm upgrade`; Migrationen laufen beim Start.
