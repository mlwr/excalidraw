# Roadmap

Grundlage ist die Priorisierung vom 11.11.2026 (Muss, Soll, Kann, Gestrichen) der Excalidraw+-Funktionen und der Bausteine für den Betrieb im Intranet.

## Phasen

| Phase | Inhalt | Status |
| --- | --- | --- |
| 1 Fundament | B1 Server mit Datenbank, B2 Keycloak-SSO, B3 Rollen und Gruppen, B4 Echtzeit-Server, B5 keine Internet-Aufrufe, B6 Deployment (Helm), S1 Sicherheits-Grundschutz, E1 Bilder bis 4K | umgesetzt |
| 2 Workspace | W2 Szenen auf dem Server, W1 Dashboard, W3 Collections, T1 Teilen mit Personen und Teams, T2 Nur-Lese-Links, Z1 dauerhafte Live-Zusammenarbeit | umgesetzt |
| 3 Kommentare und Schnittstellen | Z2 Kommentare, I1 REST-API, I2 MCP-Server | umgesetzt |
| 4 Soll: Ablage und Betrieb | W5 Papierkorb, W6 Suche, W7 Versionsverlauf, W8 Aktivitäts-Feed, W9 Export, W10 mehrere Workspaces, T5 Admin-Richtlinien, S2 Audit-Log, S3 Löschkonzept, B7 Monitoring/Backups, B8 Branding | umgesetzt |
| 5 Soll: Zusammenarbeit, Präsentation, KI, Bibliotheken | Z3 Benachrichtigungen, Z4 Spotlight, T3 Einbetten, P1 Präsentationsmodus, P7 Export PDF/PPTX, K1 KI mit internem Sprachmodell, K2 KI-Steuerung, L1 persönliche Bibliothek, L2 Team-Bibliotheken, E4 PDF-Import | umgesetzt |
| 6 Kann | W4 Unterordner, E2 Einbettungen aus dem Intranet, E3 Firmenschriften, L3 interner Bibliothekskatalog, I3 Kommandozeilen-Tool, P2 Folien-Editor und Layouts, P3 Referentenansicht, P4 Fernbedienung, P5 Animationen, P6 Live-Präsentation (S4 seit Phase 1) | umgesetzt |

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

### Phase 4 im Detail

- **W5** Papierkorb je Workspace: Gelöschte Szenen lassen sich wiederherstellen (von allen, die sie bearbeiten durften, und von der Person, die gelöscht hat) oder endgültig löschen. Nach der Frist des Workspaces (Standard 30 Tage) löscht der Server sie mit Versionen, Kommentaren und Bildern.
- **W6** Suche über Namen, Texte in Zeichnungen (auch Beschriftungen, Frame-Namen, Links) und Kommentare, mit Textausschnitt im Ergebnis. Gesucht wird nach Wortanfängen („Urlaub“ findet „Urlaubsantrag“), alle Wörter müssen vorkommen. Der Index enthält keine Wörter, nur verschlüsselte Hashes ([Datenschutz](./datenschutz.md#suche)). Auch über REST-API und MCP.
- **W7** Versionsverlauf im Editor (Hauptmenü): Vor dem Speichern sichert der Server den vorherigen Stand, höchstens alle 10 Minuten, nach zwei Tagen einer pro Tag, bis 90 Tage nach der Sicherung. Alle mit Zugriff über eine Collection oder Freigabe sehen Vorschauen (über einen Nur-Lese-Link nicht: der zeigt nur den aktuellen Stand); wer bearbeiten darf, stellt einen Stand für alle wieder her (der ersetzte Stand bleibt im Verlauf).
- **W8** Aktivität je Workspace: wer was angelegt, bearbeitet, verschoben, geteilt, kommentiert oder gelöscht hat, nur für Szenen und Collections, die man sehen darf. Mehrere Speichervorgänge einer Person innerhalb einer halben Stunde sind ein Eintrag.
- **W9** Export als ZIP: alles, was man in einem Workspace sehen darf, oder eine Collection, als `.excalidraw`-Dateien mit Bildern und einer `manifest.json`. Auch über `GET /api/v1/export`.
- **W10** Mehrere Workspaces mit Mitgliedern (Personen oder Keycloak-Gruppen) und Workspace-Admins. Der allgemeine Workspace ist für alle offen. Wer kein Mitglied ist, sieht in einem Workspace nur, was mit ihm geteilt wurde.
- **T5** Richtlinien je Workspace: Nur-Lese-Links, direktes Teilen einzelner Szenen, wer Collections anlegt, wer exportiert, Frist im Papierkorb. Abschalten entfernt bestehende Links und Freigaben sofort; wird eine Szene in einen Workspace verschoben, gelten ab dann dessen Richtlinien.
- **S2** Audit-Log für App-Admins: Anmeldungen (auch abgelehnte), Tokens, Freigaben, Exporte, Löschungen und Verwaltungsaktionen mit Zeit, Person und Adresse; Filter nach Art und Zeitraum, Download als CSV.
- **S3** Löschkonzept mit festen Fristen und dem Entfernen von Personen samt Übergabe ihrer Szenen ([Datenschutz und Löschkonzept](./datenschutz.md)).
- **B7** Prometheus-Metriken auf eigenem Port, ServiceMonitor und Alarmregeln, nächtlicher `pg_dump` als CronJob ([Betrieb](./betrieb.md#monitoring)).
- **B8** Branding: Name, Akzentfarbe, Logo und Links (z. B. Hilfe, Datenschutzhinweise) unter „Verwaltung“.

Bekannte Grenzen:

- Die Suche findet Wortanfänge, keine Wortteile in der Mitte („antrag“ findet „Urlaubsantrag“ nicht) und keine Tippfehler.
- Versionen zeigen Bilder in der Vorschau nur, solange das Bild noch in der Szene vorkommt.
- Szenen lassen sich in der Übersicht nur innerhalb eines Workspaces verschieben; über die REST-API auch in Collections anderer Workspaces.
- Das Audit-Log zeigt IDs von Szenen, nicht ihre Namen, wenn die Szene inzwischen gelöscht ist.
- Die Export-Richtlinie betrifft den ZIP-Export ganzer Workspaces und Collections. Einzelne Szenen lassen sich weiterhin im Editor speichern und über die REST-API lesen; wer das unterbinden will, schaltet die API ab oder beschränkt sie auf eine Rolle (`API_REQUIRED_ROLE`).
- Beim Update auf Phase 4 kommen Szenen, die vorher gelöscht (nur ausgeblendet) wurden, in den Papierkorb; ihre Frist beginnt mit dem Update.

### Phase 5 im Detail

- **K1** Text zu Diagramm (Chat, erzeugt Mermaid) und Wireframe zu Code über einen OpenAI-kompatiblen Endpunkt des Unternehmens (vLLM, Ollama, LiteLLM, Azure OpenAI), gestreamt über den eigenen Server; Schlüssel bleiben dort, Eingaben werden nicht gespeichert ([Betrieb](./betrieb.md#ki-mit-eigenem-sprachmodell)).
- **K2** Unter „Verwaltung → KI“: an/aus, nur für eine Keycloak-Rolle, Tageslimit pro Person, Nutzung pro Tag (Anfragen, Personen, Tokens; keine Auswertung je Person).
- **L1** Die eigene Bibliothek liegt mit dem Konto auf dem Server (verschlüsselt); was im Browser lag, wird einmalig übernommen.
- **L2** Team-Bibliotheken je Collection (gepflegt von deren Bearbeitenden) und Firmenbibliotheken je Workspace (gepflegt von dessen Admins), in der Seitenleiste: ziehen oder klicken zum Einfügen, Auswahl hinzufügen, Einträge entfernen.
- **Z3** Benachrichtigungen bei Erwähnungen, Antworten in eigenen Threads und neuen Freigaben (auch an Gruppen bis 50 Personen): Glocke in Übersicht und Editor, live in offenen Editoren, per E-Mail über das interne Relay gebündelt, wenn ungelesen; je Art abbestellbar.
- **Z4** Spotlight in Live-Sitzungen: Alle folgen der Ansicht der präsentierenden Person, auch wer später dazukommt; wer selbst schauen will, verlässt es.
- **P1** Präsentationsmodus: Frames sind Folien, Vollbild, Pfeiltasten, Laserpointer (L), Folienübersicht mit Umsortieren in der Seitenleiste.
- **P7** Export aller Folien als PDF oder PowerPoint (16:9, hochaufgelöste Bilder je Folie).
- **E4** PDF-Import im Browser: jede Seite als Bild in einem eigenen Frame (bis 50 Seiten).
- **T3** Einbetten per iframe in Wiki- und Intranetseiten: Nur-Ansicht, aktualisiert sich alle 15 Sekunden, für Angemeldete oder, wenn der Workspace es erlaubt, ohne Anmeldung ([Betrieb](./betrieb.md#einbetten-in-wiki-und-intranet)).

Bekannte Grenzen:

- PDF- und PowerPoint-Export enthalten Bilder der Folien; Texte sind dort nicht bearbeitbar.
- PDF-Seiten werden als Bilder eingefügt (Text darin ist nicht durchsuchbar).
- Spotlight und Folgen wirken nur in Live-Sitzungen; Personen mit Leserecht folgen, präsentieren aber nicht im Spotlight.
- Benachrichtigungen bei Freigaben an große Gruppen (über 50 bekannte Personen) entfallen, um Massenmails zu vermeiden.
- Wireframe zu Code braucht ein Modell mit Bildverständnis (`AI_VISION_MODEL`).

### Phase 6 im Detail

- **W4** Team-Collections bis fünf Ebenen tief; Zugriff gilt für alles darin, Unterordner haben zusätzlich eigene Freigaben. Baum in der Seitenleiste, Pfad über dem Titel, Unterordner über den Szenen; Verschieben ohne Zyklen; Papierkorb, Suche und Export (Ordnerpfade im ZIP) folgen dem Baum.
- **E2** „Verwaltung → Editor“: erlaubte Intranet-Hosts für Web-Einbettungen in Szenen, externe Dienste schaltbar (Standard aus). Editor und Content-Security-Policy folgen der Liste ohne neuen Build ([Betrieb](./betrieb.md#einbettungen-in-szenen)).
- **E3** Firmenschriften (TTF, OTF, WOFF2) für alle im Schriftmenü, eingebettet in Exporte und in die Bilder der API ([Betrieb](./betrieb.md#firmenschriften)).
- **L3** Katalog unter `/libraries` und über „Bibliotheken durchsuchen“: veröffentlichen (Datei oder eigene Bibliothek), Vorschau, Suche, mit einem Klick in die eigene oder eine Team-Bibliothek oder in den offenen Editor ([Betrieb](./betrieb.md#bibliothekskatalog)).
- **I3** Szenen und Frames als SVG oder PNG über die API, gerendert auf dem Server; Kommandozeilen-Tool `excalidraw.mjs` zum Auflisten, Exportieren, Importieren und Rendern ([API](./api.md#bilder-und-kommandozeile)).
- **P2** Neue Folie mit Layouts (Titel und Inhalt, Titelfolie, zwei Spalten, Abschnitt, leer), auch mit Alt+A; Umsortieren per Ziehen.
- **P3** Sprechernotizen je Folie; Referentenansicht in einem zweiten Fenster mit aktueller und nächster Folie, Notizen (Links klickbar) und Zeit.
- **P4** Fernbedienung per QR-Code auf dem Smartphone: weiterschalten, Notizen und Zeit sehen.
- **P5** Einblendungen: ausgewählte Elemente einer Folie erscheinen Klick für Klick (nur auf dem Bildschirm der vortragenden Person ausgeblendet; die Szene bleibt, wie sie ist).
- **P6** Live-Präsentation: Link für das Publikum, Warteraum bis zum Start, Folien im eigenen Browser, Emoji-Reaktionen und Handzeichen mit Namen bei der vortragenden Person.

Nach dem Review der Phase:

- Der Server rendert Bilder und Bibliotheksvorschauen in einem eigenen Prozess mit Speicher- und Zeitgrenze; zu aufwendige Szenen beenden diesen Prozess, nicht den Server. Elemente und eingebettete Bilder haben Größengrenzen ([Betrieb](./betrieb.md#kommandozeile-und-bilder)).
- Unterordner geben niemandem mehr Rechte als der Ordner darüber; Änderungen am Ordnerbaum laufen nacheinander (keine Schleifen, keine Unterordner in gelöschten Ordnern).
- Die Ratenbegrenzung richtet sich nach der aufgerufenen Route, nicht nach der Schreibweise der Adresse.
- Die Fernbedienung erreicht nur dasselbe Konto; Präsentations-Nachrichten sind begrenzt, den Namen der vortragenden Person setzt der Server, Neuzugänge bekommen die Folie allein, nach Verbindungsabbrüchen verbindet sich alles neu.
- Einblendungen verbergen auch eingebettete Webseiten, und verborgene Elemente lassen sich nicht anklicken.
- `/` kommt nie mehr aus dem Cache des Service Workers (dort liegt nur eine Kopie für den Betrieb ohne Verbindung).
- Firmenschriften werden beim Entfernen gelöscht; mehrere Instanzen gleichen sich nach spätestens zehn Sekunden ab. Der Katalog übernimmt Änderungen an Einträgen und schreibt nichts, wenn nichts neu ist.

Bekannte Grenzen:

- Das Publikum einer Live-Präsentation sieht Bilder der Folien (keine Live-Zeichenfläche); Laserpointer und Änderungen während des Vortrags erscheinen erst mit der nächsten Folie oder Einblendung.
- Einblendungen gelten beim Präsentieren, nicht im PDF- und PowerPoint-Export (dort erscheint jede Folie vollständig).
- Die Fernbedienung braucht ein Smartphone mit Zugang zur App (Firmennetz oder VPN), angemeldet mit demselben Konto.
- Eine entfernte Firmenschrift fehlt danach auch in älteren Zeichnungen (Ersatzschrift).
- In PNGs der API fehlen eingebettete Bilder über 16 Megapixel; sehr aufwendige Szenen (mehr als 20 Sekunden) gibt es nur als Ausschnitt (Frame).

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
| W4 | Unterordner | Kann (Phase 6) |
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
| P2 | Folien-Editor und Layouts | Kann (Phase 6) |
| P3 | Referentenansicht mit Notizen | Kann (Phase 6) |
| P4 | Fernbedienung per Smartphone | Kann (Phase 6) |
| P5 | Animationen | Kann (Phase 6) |
| P6 | Live-Präsentation fürs Publikum | Kann (Phase 6) |
| P7 | Export als PDF und PowerPoint | Soll |
| K1 | KI mit internem Sprachmodell | Soll |
| K2 | KI-Steuerung und Kontingente | Soll |
| E1 | Bilder in voller Auflösung | Muss |
| E2 | Einbettungen aus dem Intranet | Kann (Phase 6) |
| E3 | Firmenschriften | Kann (Phase 6) |
| E4 | PDF-Import | Soll |
| E5 | Formatierter Text | Gestrichen |
| L1 | Persönliche Bibliothek auf dem Server | Soll |
| L2 | Team- und Firmenbibliotheken | Soll |
| L3 | Interner Bibliothekskatalog | Kann (Phase 6) |
| I1 | REST-API | Muss |
| I2 | MCP-Server für KI-Assistenten | Muss |
| I3 | Kommandozeilen-Tool | Kann (Phase 6) |
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
