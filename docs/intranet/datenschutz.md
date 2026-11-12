# Datenschutz und Löschkonzept

Diese Seite beschreibt, welche personenbezogenen Daten Excalidraw im Intranet speichert, wie lange, und wie Personen entfernt werden (S3). Sie ist eine technische Grundlage für das Verzeichnis der Verarbeitungstätigkeiten und das Löschkonzept des Unternehmens, ersetzt aber keine Prüfung durch den Datenschutz.

## Was gespeichert wird

| Daten | Inhalt | Schutz | Gelöscht |
| --- | --- | --- | --- |
| Personen | Keycloak-ID, Name, E-Mail, Benutzername, Rollen, Gruppen, Zeitpunkt der letzten Anmeldung | Abgleich bei jeder Anmeldung mit Keycloak | beim Entfernen der Person (siehe unten) |
| Sitzungen | Hash des Sitzungs-Cookies, Keycloak-Sitzungs-ID, ID-Token für das Abmelden, Browser-Kennung | nur Hashes der Cookies | nach Ablauf (`SESSION_TTL_HOURS`, Standard 10 h), spätestens 15 min danach; beim Sperren und Abmelden sofort |
| Szenen, Kommentare, Versionen, Bilder, Vorschaubilder | Inhalte der Zeichnungen und Kommentartexte | verschlüsselt (AES-GCM, ein Schlüssel je Szene, versiegelt mit `DATA_ENCRYPTION_KEY`) | mit der Szene, nach der Frist im Papierkorb |
| Suchindex | 64-Bit-Hashes der Wörter und Wortanfänge einer Szene | HMAC mit einem Schlüssel aus `DATA_ENCRYPTION_KEY`, keine Wörter im Klartext | mit der Szene; bei Änderungen neu berechnet |
| Freigaben, Mitgliedschaften | wer welche Collection, Szene oder welchen Workspace sehen darf | – | wenn sie entzogen werden, beim Entfernen der Person |
| „Zuletzt geöffnet“ | wer wann welche Szene geöffnet hat | – | nach `VISIT_RETENTION_DAYS` (Standard 180 Tage) |
| Audit-Log und Aktivität | Zeit, Person (ID und Name), Art des Ereignisses, betroffene Szene oder Collection (mit Namen), IP-Adresse, Browser-Kennung | nur App-Admins sehen das Audit-Log; die Aktivität zeigt keine Adressen und nur Ereignisse sichtbarer Szenen | nach `AUDIT_RETENTION_DAYS` (Standard 365 Tage) |
| API-Tokens | Name, Hash des Tokens, letzte Nutzung | nur Hashes | widerrufene und abgelaufene Tokens nach 90 Tagen |
| Server-Logs | Anfragen mit Pfad, Status und Adresse (stdout) | Cookies und Authorization-Header geschwärzt | nach den Regeln der Log-Plattform des Clusters (Empfehlung: 30 Tage) |
| Backups | alles oben, verschlüsselte Inhalte bleiben verschlüsselt | getrennt vom Schlüssel aufbewahren | nach `backup.keep` Nächten (Standard 14) |

Live-Sitzungen (Mauszeiger, Auswahl) laufen über den Server, werden aber nicht gespeichert. Ad-hoc-Sitzungen und Teilen-Links des Original-Excalidraw (`/#room=`, `/#json=`) sind Ende-zu-Ende-verschlüsselt; der Server sieht ihre Schlüssel nie.

## Fristen

| Frist | Standard | Einstellung |
| --- | --- | --- |
| Papierkorb | 30 Tage | je Workspace unter „Verwaltung → Workspaces → Richtlinien“; Vorgabe für neue Workspaces `TRASH_RETENTION_DAYS` |
| Versionen | 90 Tage, nach zwei Tagen eine pro Tag, höchstens 200 je Szene | `VERSION_RETENTION_DAYS`, `VERSION_INTERVAL_MINUTES` |
| Gelöschte Kommentare | wie der Papierkorb (`TRASH_RETENTION_DAYS`) | – |
| Audit-Log | 365 Tage | `AUDIT_RETENTION_DAYS` |
| „Zuletzt geöffnet“ | 180 Tage | `VISIT_RETENTION_DAYS` |
| Widerrufene oder abgelaufene Tokens | 90 Tage | – |
| Sitzungen | 10 Stunden | `SESSION_TTL_HOURS` |

Die Fristen setzt der Server selbst durch: Hintergrundaufgaben löschen stündlich bzw. alle sechs Stunden, was abgelaufen ist. Läuft eine dieser Aufgaben nicht, meldet das Monitoring es ([Betrieb](./betrieb.md#monitoring)).

## Gelöschte Szenen

Wer eine Szene löscht, legt sie in den Papierkorb des Workspaces. Dort holen sie alle zurück, die sie bearbeiten durften, und die Person, die gelöscht hat. Nach der Frist, oder vorher mit „Endgültig löschen“, entfernt der Server

- die Szene mit ihrem verschlüsselten Inhalt und ihrem Schlüssel,
- alle Versionen und Kommentare,
- den Suchindex der Szene, ihre Freigaben und Einträge in „Zuletzt geöffnet“,
- Bilder und Vorschaubilder im Speicher (PostgreSQL oder S3).

Im Audit-Log bleibt bis zu dessen Frist stehen, dass die Szene existierte, mit ihrem Namen.

## Personen entfernen

Für Personen, die das Unternehmen verlassen, oder auf Antrag (Art. 17 DSGVO): „Verwaltung → Personen → Entfernen …“ (nur App-Admins).

Dabei

- übernimmt eine gewählte Nachfolge die persönlichen Szenen („Meine Szenen“) in allen Workspaces; ohne Nachfolge kommen sie in den Papierkorb und werden nach dessen Frist gelöscht,
- werden Name, E-Mail, Benutzername, Rollen und Gruppen gelöscht; die Person heißt danach überall „Gelöschte Person“ (in Szenen, Kommentaren, Versionen, Aktivität und Audit-Log),
- werden IP-Adressen und Browser-Kennungen ihrer Einträge im Audit-Log gelöscht,
- enden Sitzungen und API-Tokens; Freigaben, Mitgliedschaften und „Zuletzt geöffnet“ werden gelöscht,
- wird die Verknüpfung mit dem Keycloak-Konto gelöst: meldet sich dasselbe Konto später an, entsteht ein neues, leeres Konto.

Was bleibt: Szenen in Team-Collections und Kommentare der Person (als „Gelöschte Person“), denn sie gehören zur Arbeit des Teams. Texte, die andere geschrieben haben (z. B. ein Name in einer Zeichnung oder ein „@Name“ in einem Kommentar), ändert das Entfernen nicht; sie lassen sich mit der Suche finden und von Hand bearbeiten.

Das Konto in Keycloak verwaltet die Identitätsverwaltung selbst. Wird es dort deaktiviert oder gelöscht, kommt die Person nicht mehr hinein; die Daten in Excalidraw entfernt erst der Schritt oben. „Sperren“ beendet nur sofort alle Sitzungen und Tokens und lässt die Daten stehen.

## Suche

Damit die Suche Texte in verschlüsselten Zeichnungen und Kommentaren findet, ohne sie im Klartext zu speichern, legt der Server für jedes Wort und jeden Wortanfang (3 bis 15 Zeichen) einen verschlüsselten Hash ab (HMAC-SHA-256, gekürzt auf 64 Bit, Schlüssel abgeleitet aus `DATA_ENCRYPTION_KEY`). Ein Datenbank-Dump ohne Schlüssel verrät keine Wörter, nur, welche Szenen gleiche Wörter enthalten. Wer zusätzlich den Schlüssel hat, kann ohnehin alle Inhalte entschlüsseln.

Treffer und Textausschnitte bekommen nur Personen, die die Szene sehen dürfen; die Ausschnitte entstehen beim Suchen aus dem entschlüsselten Inhalt und werden nicht gespeichert.

Mit `SEARCH_CONTENT=false` sucht die App nur in Namen. Schon vorhandene Indexeinträge werden dann nicht mehr benutzt und mit `truncate scene_search;` entfernt.

## Backups

Backups enthalten auch, was nach ihrer Erstellung gelöscht wurde. Gelöscht ist eine Szene oder Person also endgültig, wenn das letzte ältere Backup abgelaufen ist (mit dem Chart-CronJob nach `backup.keep` Nächten). Wird ein Backup zurückgespielt, sind Entfernungen seit dem Backup-Datum zu wiederholen: Das Audit-Log nennt sie („Person entfernt“, Ziel = ID der Person; „Szene endgültig gelöscht“).

## Auskunft

Für eine Auskunft (Art. 15 DSGVO) liefern

- „Verwaltung → Personen“ die gespeicherten Stammdaten,
- `GET /api/admin/audit?format=csv&actor=<ID der Person>` (als App-Admin angemeldet) alle Einträge der Person im Audit-Log,
- der Export in der Übersicht („Alles exportieren“, durch die Person selbst) ihre Szenen als `.excalidraw`-Dateien.

## Rollen und Einsicht

| Rolle | sieht |
| --- | --- |
| Alle Angemeldeten | eigene und geteilte Szenen, Aktivität dieser Szenen, Namen von Personen und Gruppen beim Teilen |
| Workspace-Admins | zusätzlich alle Team-Collections, Mitglieder und Richtlinien ihres Workspaces |
| App-Admins (`excalidraw-admin`) | zusätzlich alle Personen, das Audit-Log mit Adressen, Kennzahlen; sie können Personen sperren und entfernen |

Den Inhalt einer Szene sehen auch App-Admins nur, wenn sie über eine Collection oder Freigabe Zugriff haben (App-Admins verwalten alle Team-Collections). Persönliche Szenen anderer bleiben ihnen verborgen.
