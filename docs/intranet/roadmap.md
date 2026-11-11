# Roadmap

Grundlage ist die Priorisierung vom 11.11.2026 (Muss, Soll, Kann, Gestrichen) der Excalidraw+-Funktionen und der Bausteine für den Betrieb im Intranet.

## Phasen

| Phase | Inhalt | Status |
| --- | --- | --- |
| 1 Fundament | B1 Server mit Datenbank, B2 Keycloak-SSO, B3 Rollen und Gruppen, B4 Echtzeit-Server, B5 keine Internet-Aufrufe, B6 Deployment (Helm), S1 Sicherheits-Grundschutz, E1 Bilder bis 4K | umgesetzt |
| 2 Workspace | W2 Szenen auf dem Server, W1 Dashboard, W3 Collections, T1 Teilen mit Personen und Teams, T2 Nur-Lese-Links, Z1 dauerhafte Live-Zusammenarbeit | geplant |
| 3 Kommentare und Schnittstellen | Z2 Kommentare, I1 REST-API, I2 MCP-Server | geplant |
| 4 Soll: Ablage und Betrieb | W5 Papierkorb, W6 Suche, W7 Versionsverlauf, W8 Aktivitäts-Feed, W9 Export, W10 mehrere Workspaces, T5 Admin-Richtlinien, S2 Audit-Log, S3 Löschkonzept, B7 Monitoring/Backups, B8 Branding | geplant |
| 5 Soll: Zusammenarbeit, Präsentation, KI, Bibliotheken | Z3 Benachrichtigungen, Z4 Spotlight, T3 Einbetten, P1 Präsentationsmodus, P7 Export PDF/PPTX, K1 KI mit internem Sprachmodell, K2 KI-Steuerung, L1 persönliche Bibliothek, L2 Team-Bibliotheken, E4 PDF-Import | geplant |
| 6 Kann | E2, E3, I3, L3, P2–P6, S4, W4 nach Bedarf | offen |

Das Datenmodell enthält von Anfang an Workspaces, damit W10 ohne Umbau möglich bleibt.

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

## Offene Rahmenbedingungen

Diese Angaben fehlen noch und bestimmen spätere Phasen:

- Gibt es intern ein Sprachmodell (Azure OpenAI, vLLM, Ollama …)? (K1, K2)
- Ungefähre Nutzerzahl und gleichzeitige Nutzung (Skalierung)
- Vorhandenes PostgreSQL (z. B. CloudNativePG) und S3-Speicher?
- Keycloak-Version und Gruppenstruktur (Abteilungen als Teams für T1)
