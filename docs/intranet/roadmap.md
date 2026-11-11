# Roadmap

Grundlage ist die Priorisierung vom 11.11.2026 (Muss, Soll, Kann, Gestrichen) der Excalidraw+-Funktionen und der Bausteine für den Betrieb im Intranet.

## Phasen

| Phase | Inhalt | Status |
| --- | --- | --- |
| 1 Fundament | B1 Server mit Datenbank, B2 Keycloak-SSO, B3 Rollen und Gruppen, B4 Echtzeit-Server, B5 keine Internet-Aufrufe, B6 Deployment (Helm), S1 Sicherheits-Grundschutz, E1 Bilder bis 4K | umgesetzt |
| 2 Workspace | W2 Szenen auf dem Server, W1 Dashboard, W3 Collections, T1 Teilen mit Personen und Teams, T2 Nur-Lese-Links, Z1 dauerhafte Live-Zusammenarbeit | umgesetzt |
| 3 Kommentare und Schnittstellen | Z2 Kommentare, I1 REST-API, I2 MCP-Server | umgesetzt |
| 4 Soll: Ablage und Betrieb | W5 Papierkorb, W6 Suche, W7 Versionsverlauf, W8 Aktivitäts-Feed, W9 Export, W10 mehrere Workspaces, T5 Admin-Richtlinien, S2 Audit-Log, S3 Löschkonzept, B7 Monitoring/Backups, B8 Branding | geplant |
| 5 Soll: Zusammenarbeit, Präsentation, KI, Bibliotheken | Z3 Benachrichtigungen, Z4 Spotlight, T3 Einbetten, P1 Präsentationsmodus, P7 Export PDF/PPTX, K1 KI mit internem Sprachmodell, K2 KI-Steuerung, L1 persönliche Bibliothek, L2 Team-Bibliotheken, E4 PDF-Import | geplant |
| 6 Kann | E2, E3, I3, L3, P2–P6, S4, W4 nach Bedarf | offen |

Das Datenmodell enthält von Anfang an Workspaces, damit W10 ohne Umbau möglich bleibt.

### Phase 2 im Detail

- **W2** Szenen liegen verschlüsselt auf dem Server (ein Schlüssel je Szene, versiegelt mit `DATA_ENCRYPTION_KEY`). Gespeichert wird laufend während des Zeichnens, Konflikte zwischen Pods verhindert eine Revisionsnummer.
- **W1** Dashboard unter `/` mit „Zuletzt geöffnet“, „Meine Szenen“, „Mit mir geteilt“, Collections, Suche, Sortierung, Vorschaubildern und der Anzeige, wer gerade zeichnet. Import von `.excalidraw`-Dateien als neue Szene.
- **W3** Persönliche Collection je Person, Team-Collections mit Freigaben an Personen und Keycloak-Gruppen (einschließlich Untergruppen), Szenen verschieben.
- **T1** Freigabe einzelner Szenen an Personen oder Gruppen, Suche im Verzeichnis aller bisher angemeldeten Personen und ihrer Gruppen.
- **T2** Nur-Lese-Link je Szene, abschaltbar; nur für angemeldete Personen.
- **Z1** Jede Szene ist zugleich ein Live-Raum; Berechtigte treten beim Öffnen bei, Personen mit Leserecht sehen Änderungen und Mauszeiger live, können aber nichts ändern.

Bekannte Grenzen, die später folgen:

- Gelöschte Szenen sind nur ausgeblendet (W5, S3).
- Keine Unterordner (W4).
- Kein Austausch von Schlüsseln im laufenden Betrieb, weder des Hauptschlüssels noch der Szenenschlüssel (Schlüsselrotation, mit S3 in Phase 4). Wer früher Zugriff hatte, kennt den Szenenschlüssel noch; ohne Zugriff auf Server, Datenbank oder Backups nützt er ihm nichts.
- Das Verzeichnis kennt nur Personen, die sich schon einmal angemeldet haben.
- Gruppen und Rollen werden bei der Anmeldung aus Keycloak übernommen; Änderungen in Keycloak wirken mit der nächsten Anmeldung (spätestens nach `SESSION_TTL_HOURS`).

### Phase 3 im Detail

- **Z2** Kommentare an einer Stelle oder an einem Element (wandern mit), Antworten, „Erledigt“, Bearbeiten und Löschen, Liste offener und erledigter Kommentare, live bei allen, die die Szene geöffnet haben. Auch Personen mit Leserecht kommentieren. Texte sind mit dem Szenenschlüssel verschlüsselt.
- **I1** REST-API unter `/api/v1` mit OpenAPI-Beschreibung: Szenen und Collections, Export und Import als `.excalidraw` mit Bildern, Elemente hinzufügen, ändern und löschen, Diagramme aus Knoten und Kanten, Kommentare ([REST-API](./api.md)).
- **I2** MCP-Server unter `/mcp` (Streamable HTTP) mit Werkzeugen zum Suchen, Lesen, Zeichnen, Ändern und Kommentieren ([MCP](./mcp.md)).
- Persönliche API-Tokens im Dashboard: nur lesen oder lesen und schreiben, mit Ablaufzeit, widerrufbar, optional nur für eine Keycloak-Rolle.
- Was über API oder MCP geändert wird, erscheint sofort in offenen Editoren. Der Server erzeugt Formen, Beschriftungen und Pfeile mit der Element-Logik des Editors selbst.

Bekannte Grenzen:

- Erwähnungen (@) werden gespeichert, aber noch nicht gemeldet; Benachrichtigungen folgen mit Z3 in Phase 5.
- Szenen, die nur per API entstehen oder geändert werden, bekommen ihr Vorschaubild erst, wenn jemand sie im Browser öffnet.
- Kommentare sind auf Smartphones noch nicht bedienbar (Markierungen ja, Liste und Eingabe nein).
- MCP-Clients melden sich mit persönlichen Tokens an. Anmeldung per OAuth über Keycloak (MCP-Autorisierung) wäre eine spätere Ausbaustufe.
- Diagramme werden in Ebenen mit geraden Pfeilen angeordnet; rechtwinklige Pfeile lassen sich über API und MCP noch nicht anlegen.

## Priorisierung

| ID | Funktion | Priorität |
| --- | --- | --- |
| B1 | Eigener Server mit Datenbank | Muss |
| B2 | Anmeldung über Keycloak (SSO) | Muss |
| B3 | Rollen und Gruppen aus Keycloak | Muss |
| B4 | Eigener Echtzeit-Server | Muss |
| B5 | Keine Aufrufe ins Internet | Muss |
| B6 | Deployment-Paket (Kubernetes ist Pflicht) | Muss |
| B7 | Betrieb: Monitoring, Logs, Backups | Soll |
| B8 | Eigenes Branding | Soll |
| W1 | Dashboard | Muss |
| W2 | Unbegrenzte Szenen auf dem Server | Muss |
| W3 | Collections | Muss |
| W4 | Unterordner | Kann |
| W5 | Papierkorb | Soll |
| W6 | Suche über alle Szenen | Soll |
| W7 | Versionsverlauf | Soll |
| W8 | Aktivitäts-Feed | Soll |
| W9 | Workspace-Export | Soll |
| W10 | Mehrere Workspaces | Soll |
| T1 | Teilen mit Personen und Teams | Muss |
| T2 | Nur-Lese-Links | Muss |
| T3 | Einbetten in Wiki und Intranet | Soll |
| T4 | Gastzugang für Externe | Gestrichen |
| T5 | Admin-Richtlinien | Soll |
| Z1 | Dauerhafte Live-Zusammenarbeit | Muss |
| Z2 | Kommentare | Muss |
| Z3 | Benachrichtigungen | Soll |
| Z4 | Spotlight | Soll |
| Z5 | Sprachkanal und Bildschirmfreigabe | Gestrichen |
| P1 | Präsentationsmodus | Soll |
| P2 | Folien-Editor und Layouts | Kann |
| P3 | Referentenansicht mit Notizen | Kann |
| P4 | Fernbedienung per Smartphone | Kann |
| P5 | Animationen | Kann |
| P6 | Live-Präsentation fürs Publikum | Kann |
| P7 | Export als PDF und PowerPoint | Soll |
| K1 | KI mit internem Sprachmodell | Soll |
| K2 | KI-Steuerung und Kontingente | Soll |
| E1 | Bilder in voller Auflösung | Muss |
| E2 | Einbettungen aus dem Intranet | Kann |
| E3 | Firmenschriften | Kann |
| E4 | PDF-Import | Soll |
| E5 | Formatierter Text | Gestrichen |
| L1 | Persönliche Bibliothek auf dem Server | Soll |
| L2 | Team- und Firmenbibliotheken | Soll |
| L3 | Interner Bibliothekskatalog | Kann |
| I1 | REST-API | Muss |
| I2 | MCP-Server für KI-Assistenten | Muss |
| I3 | Kommandozeilen-Tool | Kann |
| I4 | Confluence und Jira | Gestrichen |
| I5 | GitLab und GitHub | Gestrichen |
| S1 | Sicherheits-Grundschutz | Muss |
| S2 | Audit-Log | Soll |
| S3 | Datenschutz und Löschkonzept | Soll |
| S4 | Verschlüsselte Ad-hoc-Sitzungen | Kann (in Phase 1 bereits enthalten) |

## Rahmenbedingungen

Geklärt am 11.11.2026:

- **Sprachmodell** für K1 und K2: intern vorhanden, derzeit Gemma 4 31B, alternativ Qwen 3.8 27B.
- **Nutzerzahl**: rund 200 Personen. Zwei Pods (Ausfallsicherheit) reichen; `REALTIME_CLUSTER` hält Live-Sitzungen über beide zusammen.
- **PostgreSQL und S3**: je eine eigene Instanz nur für Excalidraw. Empfehlung: `storage.driver: s3` für Bilder und Vorschaubilder.
- **Keycloak** wird selbst administriert: Client, Rollen und Gruppen-Mapper laut [Betrieb](./betrieb.md#2-keycloak-einrichten).
- **Speicherung der Workspace-Szenen**: serverseitig verschlüsselt statt Ende-zu-Ende, damit Freigaben, Nur-Lese-Links, Vorschaubilder und später Suche, API, MCP und KI funktionieren. Ad-hoc-Sitzungen und Teilen-Links bleiben Ende-zu-Ende-verschlüsselt.
