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

Sollen nur bestimmte Personen API-Tokens für Skripte und KI-Assistenten bekommen, eine weitere Client-Rolle (z. B. `excalidraw-api`) anlegen, zuweisen und im Chart `api.requiredRole: excalidraw-api` setzen. Rollen und Gruppen werden bei der Anmeldung übernommen. Wird eine Anmeldung abgewiesen, weil die nötige Rolle fehlt, widerruft der Server alle Tokens der Person. Wer sich gar nicht mehr anmeldet (z. B. nach dem Austritt), verliert die Wirkung seiner Tokens nach `API_TOKEN_LOGIN_MAX_AGE_DAYS` Tagen (Standard 30).

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
| `API_TOKEN_LOGIN_MAX_AGE_DAYS` | `30` | Tokens gelten nur, wenn sich ihre Person in so vielen Tagen in der App angemeldet hat (Rollen und Gruppen stammen aus dieser Anmeldung); `0` = ohne Frist |
| `API_REQUIRED_ROLE` | leer | Keycloak-Rolle, ohne die niemand Tokens anlegen oder benutzen darf; leer = alle (Admins dürfen immer) |
| `API_RATE_LIMIT_PER_MINUTE` | `300` | Anfragen pro Token und Minute |
| `TRASH_RETENTION_DAYS` | `30` | Tage im Papierkorb, bevor Szenen endgültig gelöscht werden (Vorgabe für neue Workspaces; jeder Workspace kann eine eigene Frist haben) |
| `VERSION_RETENTION_DAYS` | `90` | Versionen von Szenen werden danach gelöscht |
| `VERSION_INTERVAL_MINUTES` | `10` | Höchstens eine Version pro Szene in dieser Zeit (nach zwei Tagen bleibt eine pro Tag) |
| `AUDIT_RETENTION_DAYS` | `365` | Aufbewahrung des Audit-Logs (Anmeldungen, Freigaben, Exporte, Verwaltung) |
| `VISIT_RETENTION_DAYS` | `180` | Aufbewahrung von „Zuletzt geöffnet“ |
| `SEARCH_CONTENT` | `true` | Texte in Zeichnungen und Kommentaren durchsuchbar machen (nur verschlüsselte Hashes in der Datenbank); `false` = nur Namen |
| `METRICS_PORT` | `9464` | Port für Prometheus-Metriken (`/metrics`), getrennt vom App-Port; `0` = aus |
| `AI_BASE_URL` | leer | OpenAI-kompatibler Endpunkt des eigenen Sprachmodells, z. B. `http://vllm.ki.svc:8000/v1`; leer = keine KI |
| `AI_MODEL` | – | Modell für Text zu Diagramm (Pflicht mit `AI_BASE_URL`), z. B. `google/gemma-4-31b-it` |
| `AI_VISION_MODEL` | leer | Modell mit Bildverständnis für Wireframe zu Code; leer = aus |
| `AI_API_KEY` | leer | Schlüssel des Endpunkts, falls nötig (bleibt auf dem Server) |
| `AI_DAILY_LIMIT` | `50` | Anfragen pro Person und Tag (Vorgabe, änderbar unter „Verwaltung → KI“) |
| `AI_REQUIRED_ROLE` | leer | Keycloak-Rolle für KI (Vorgabe, änderbar unter „Verwaltung → KI“); App-Admins dürfen immer |
| `AI_MAX_TOKENS`, `AI_TIMEOUT_SECONDS` | `4096`, `180` | Längste Antwort und Wartezeit auf das Modell |
| `SMTP_HOST`, `SMTP_PORT` | leer, `25` | Mailrelay für Benachrichtigungen; leer = nur in der App |
| `SMTP_SECURE` | `false` | TLS von Anfang an (Port 465); sonst STARTTLS, wenn angeboten |
| `SMTP_USER`, `SMTP_PASSWORD` | leer | Anmeldung am Relay, falls nötig |
| `SMTP_FROM` | – | Absender (Pflicht mit `SMTP_HOST`) |
| `NOTIFY_EMAIL_DELAY_MINUTES` | `10` | So lange wartet eine ungelesene Benachrichtigung, bevor sie per E-Mail kommt (mehrere werden gebündelt) |
| `EMBED_FRAME_ANCESTORS` | `https://*.<übergeordnete Domain>` | Seiten, die Szenen einbetten dürfen (CSP `frame-ancestors`, nur für `/embed/…`) |
| `TRUST_PROXY` | `1` | Vertrauenswürdige Proxy-Hops vor dem Pod |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Adresse des Servers |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_EXTRA_CA_CERTS` | – | PEM-Datei der internen CA (Node.js-Standard) |

## 5. Laufender Betrieb

- **Health**: `GET /healthz` (Prozess lebt), `GET /readyz` (Datenbank und Speicher erreichbar). Ein Ausfall von Keycloak nimmt Pods nicht aus dem Dienst; laufende Sitzungen arbeiten weiter, neue Anmeldungen schlagen fehl.
- **Logs**: JSON-Zeilen auf stdout, Cookies und Authorization-Header werden geschwärzt. Fachliche Ereignisse (Anmeldungen, Freigaben, Exporte, Verwaltung) stehen zusätzlich im Audit-Log der App.
- **Verwaltung**: App-Admins (Keycloak-Rolle `excalidraw-admin`) öffnen `/admin` über „Verwaltung“ in der Übersicht: Workspaces mit Mitgliedern und Richtlinien, Personen (sperren, Tokens beenden, entfernen), Audit-Log mit CSV-Download, Branding und Kennzahlen. Workspace-Admins sehen dort nur ihre Workspaces.
- **Hintergrundaufgaben** laufen in jedem Pod, aber dank PostgreSQL-Advisory-Locks jeweils nur in einem gleichzeitig: Suchindex (alle 20 s), Papierkorb leeren (stündlich), Versionen ausdünnen (stündlich), Fristen für Audit-Log, „Zuletzt geöffnet“, gelöschte Kommentare und abgelaufene Tokens (alle 6 h), abgelaufene Sitzungen (alle 15 min). Löschfristen siehe [Datenschutz](datenschutz.md).
- **API-Tokens** einer Person beenden: die Person selbst im Dashboard, oder ein App-Admin unter „Verwaltung → Personen“.
- **Updates**: Image-Tag erhöhen und `helm upgrade`; Migrationen laufen beim Start. Beim Update auf Phase 4 kommen bisher nur ausgeblendete, gelöschte Szenen in den Papierkorb; ihre Frist (Standard 30 Tage) beginnt mit dem Update.

### KI mit eigenem Sprachmodell

Text zu Diagramm und Wireframe zu Code laufen über jeden OpenAI-kompatiblen Endpunkt, etwa vLLM, Ollama, LiteLLM oder Azure OpenAI. Der Server reicht die Anfragen weiter und streamt die Antwort; der Browser spricht nie direkt mit dem Modell, Schlüssel bleiben auf dem Server. Beispiel mit vLLM im Cluster:

```yaml
ai:
  baseUrl: http://vllm.ki.svc:8000/v1
  model: google/gemma-4-31b-it # Text zu Diagramm (Mermaid)
  visionModel: google/gemma-4-31b-it # Wireframe zu Code (braucht Bildverständnis)
  dailyLimit: 50
```

Gemma 4 und Qwen liefern gutes Mermaid; „Denkblöcke“ (`<think>…</think>`) und Codeblock-Markierungen filtert der Server heraus. Unter „Verwaltung → KI“ schalten App-Admins die Funktionen ab, beschränken sie auf eine Keycloak-Rolle und ändern das Tageslimit; dort steht auch die Nutzung pro Tag.

### E-Mail-Benachrichtigungen

Mit `smtp.host` (und `smtp.from`) verschickt der Server ungelesene Benachrichtigungen gebündelt per E-Mail, frühestens nach `smtp.delayMinutes`. Die E-Mails enthalten nur, wer wo was getan hat, und einen Link, keine Inhalte von Kommentaren. Jede Person stellt in der Glocke ein, welche Arten per E-Mail kommen.

### Einbetten in Wiki und Intranet

Eine eingebettete Szene ist eine eigene Seite (`/embed/<token>`), die Intranetseiten per iframe zeigen. Ihre Content-Security-Policy erlaubt das für `embed.frameAncestors` (Standard: alle Hosts unter der übergeordneten Domain der App, etwa `https://*.intranet.example`); alle anderen Seiten der App lassen sich weiterhin nicht einbetten.

- Liegt die Intranetseite unter derselben Domain (z. B. `wiki.intranet.example` und `excalidraw.intranet.example`), schickt der Browser das Anmelde-Cookie mit: Angemeldete sehen die Szene, andere bekommen einen Anmelden-Knopf.
- Liegt sie unter einer anderen Domain, blockieren Browser das Cookie im iframe. Dann muss der Workspace „Einbettungen ohne Anmeldung“ erlauben (Verwaltung → Workspaces → Richtlinien); wer den Link kennt, sieht die Szene dann ohne Anmeldung.
- Die einbettende Seite muss den Host der App in ihrer eigenen CSP (`frame-src`) zulassen, falls sie eine hat.

### Monitoring

Der Server liefert Prometheus-Metriken auf einem eigenen Port (`METRICS_PORT`, Standard 9464, Pfad `/metrics`), den das Ingress nicht nach außen gibt. Im Chart:

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true # braucht den Prometheus-Operator
    labels:
      release: prometheus
  prometheusRule:
    enabled: true # Alarme, s. u.
networkPolicy:
  enabled: true
  monitoringNamespace: monitoring
```

| Metrik | Bedeutung |
| --- | --- |
| `excalidraw_http_request_duration_seconds` | Dauer der Anfragen nach Methode, Route (Muster, keine IDs) und Statusklasse |
| `excalidraw_events_total{type}` | Anmeldungen, abgelehnte Anmeldungen, Bearbeitungen, Freigaben, Exporte, Verwaltungsaktionen |
| `excalidraw_socket_connections` | Offene Live-Verbindungen pro Pod |
| `excalidraw_db_pool_connections{state}` | Datenbankverbindungen pro Pod (`total`, `idle`, `waiting`) |
| `excalidraw_job_runs_total{task,result}`, `excalidraw_job_last_success_timestamp_seconds{task}` | Hintergrundaufgaben |
| `excalidraw_users`, `excalidraw_users_active_30d`, `excalidraw_scenes`, `excalidraw_scenes_trash`, `excalidraw_versions`, `excalidraw_scene_bytes`, `excalidraw_version_bytes` | Umfang der Installation (einmal pro Minute gezählt) |
| `excalidraw_search_pending` | Szenen, die noch auf den Suchindex warten |
| `process_*`, `nodejs_*` | Speicher, CPU, Verzögerung der Event-Loop |

Die mitgelieferten Alarme (`prometheusRule.enabled`): Dienst nicht erreichbar, mehr als 5 % Serverfehler, langsame API (p95 > 2 s), wartende Datenbankverbindungen, Suchindex steht, Aufräumaufgaben laufen nicht (dann werden Löschfristen nicht eingehalten).

### Backup und Wiederherstellung

Was gesichert werden muss:

1. **PostgreSQL**: Szenen, Kommentare, Versionen, Rechte, Audit-Log; bei `STORAGE_DRIVER=postgres` auch Bilder und Vorschaubilder.
2. **S3-Bucket** (nur bei `STORAGE_DRIVER=s3`): Bilder und Vorschaubilder, am besten über Versionierung oder Replikation im S3-System.
3. **`DATA_ENCRYPTION_KEY`**, einmalig und getrennt (z. B. im Passwort-Tresor des Betriebs). Datenbank und Bucket enthalten nur Chiffretext; ohne den Schlüssel ist ein Backup wertlos, mit ihm allein kommt niemand an Inhalte.

Das Chart bringt einen nächtlichen `pg_dump` als CronJob mit, falls es keine zentrale Datenbanksicherung gibt:

```yaml
backup:
  enabled: true
  schedule: "30 2 * * *"
  keep: 14 # Anzahl Dumps
  storage: 20Gi # neues Volume, oder existingClaim: …
```

Die Dumps liegen im Format `pg_dump --format=custom` auf dem Volume (`excalidraw-JJJJMMTT-HHMMSS.dump`). `DATABASE_URL` muss dafür eine libpq-kompatible Adresse sein (z. B. `?sslmode=require`); die interne CA aus `extraCaCerts` wird genutzt.

Wiederherstellen (Beispiel, Dienst vorher auf 0 Pods skalieren):

```bash
kubectl -n excalidraw scale deploy/excalidraw --replicas=0
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" excalidraw-20261112-023000.dump
kubectl -n excalidraw scale deploy/excalidraw --replicas=2
```

Danach mit demselben `DATA_ENCRYPTION_KEY` starten. Wer ein Backup zurückspielt, stellt auch Inhalte wieder her, die nach dem Backup gelöscht wurden; das [Löschkonzept](datenschutz.md#backups) beschreibt, wie damit umzugehen ist.
