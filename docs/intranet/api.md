# REST-API

Über die REST-API lesen und ändern Skripte, Werkzeuge und Integrationen den Workspace: Szenen auflisten, als `.excalidraw` exportieren und importieren, Formen und Diagramme zeichnen, kommentieren. Die API läuft unter `/api/v1` auf derselben Adresse wie die App. Eine maschinenlesbare Beschreibung (OpenAPI 3.1) liefert `/api/v1/openapi.json`, z. B. für Client-Generatoren oder Swagger UI.

## Anmeldung mit persönlichem Token

1. Im Dashboard oben rechts **API-Tokens** öffnen.
2. Namen vergeben (wofür ist das Token?), Rechte wählen und auf **Token erzeugen** klicken:
   - **Nur lesen**: nur `GET`-Anfragen bzw. lesende MCP-Werkzeuge.
   - **Lesen und schreiben**: alles, was die Person auch in der App darf.
3. Das Token (`exc_…`) wird nur einmal angezeigt und gehört in einen Passwort-Tresor bzw. ein Secret der Pipeline.

Jede Anfrage trägt das Token im Header:

```bash
curl -H "Authorization: Bearer $EXCALIDRAW_TOKEN" https://excalidraw.intranet.example/api/v1/scenes
```

Ein Token handelt mit den Rechten seiner Person, so wie sie bei der letzten Anmeldung aus Keycloak kamen (Rollen und Gruppen). Deshalb gilt es nur, solange sich die Person regelmäßig in der App anmeldet (Standard: in den letzten 30 Tagen, `API_TOKEN_LOGIN_MAX_AGE_DAYS`); sonst antwortet die API mit `401 login_required`. Es läuft nach der gewählten Zeit ab (höchstens `API_TOKEN_MAX_DAYS`), lässt sich jederzeit widerrufen und wirkt nicht mehr, wenn die Person die nötige Rolle verliert (`OIDC_REQUIRED_ROLE`, optional `API_REQUIRED_ROLE`). Der Sitzungs-Cookie der App gilt für `/api/v1` nicht, Tokens gelten umgekehrt nicht für die App.

Grenzen: `API_RATE_LIMIT_PER_MINUTE` Anfragen pro Token und Minute (Standard 300), Szenen bis `MAX_SCENE_SIZE_MB`, Bilder bis `MAX_FILE_SIZE_MB`. Texte und Beschriftungen haben höchstens 2000 Zeichen, eine Anfrage höchstens 50 000 Zeichen Text; Breite und Höhe höchstens 100 000. Ein Export liefert Bilder bis zur Größe `MAX_SCENE_SIZE_MB`; was darüber hinausgeht, nennt `filesOmitted`.

## Endpunkte

| Methode und Pfad | Zweck |
| --- | --- |
| `GET /me` | Eigene Person und Token |
| `GET /collections` | Collections mit Zugriff, Rolle und Anzahl Szenen |
| `GET /collections/{id}/scenes` | Szenen einer Collection |
| `GET /scenes?q=&sort=&limit=&offset=` | Alle Szenen mit Zugriff (eigene, Team-Collections, direkt geteilte) |
| `POST /scenes` | Szene anlegen: leer, aus Element-Skeletten (`elements`) oder aus einer `.excalidraw`-Datei (`content`) |
| `GET /scenes/{id}` | Metadaten, Link (`url`), Revision, eigene Rechte |
| `PATCH /scenes/{id}` | Umbenennen (`name`) oder verschieben (`collectionId`) |
| `DELETE /scenes/{id}` | In den Papierkorb legen (wiederherstellen im Dashboard) |
| `GET /scenes/{id}/content` | Inhalt als `.excalidraw`-Dokument, mit Bildern (`?files=false` ohne) |
| `PUT /scenes/{id}/content` | Inhalt ersetzen, optional mit `expectedRevision` (409 bei Konflikt) |
| `POST /scenes/{id}/elements` | Elemente hinzufügen (Skelett-Format) |
| `PATCH /scenes/{id}/elements` | Elemente ändern: Text, Position, Größe, Farben, Stil |
| `DELETE /scenes/{id}/elements?ids=a,b` | Elemente mit ihren Beschriftungen löschen |
| `POST /scenes/{id}/diagram` | Diagramm aus Knoten und Kanten automatisch anordnen und hinzufügen |
| `GET /scenes/{id}/comments?status=open` | Kommentar-Threads mit Antworten |
| `POST /scenes/{id}/comments` | Kommentar an einer Stelle oder einem Element |
| `POST /comment-threads/{id}/comments` | Antworten |
| `PATCH /comment-threads/{id}` | `{"resolved": true}` erledigt, `false` wieder offen |
| `GET /search?q=&workspace=` | Suche über Namen, Texte in Zeichnungen und Kommentare; Ergebnisse mit Textausschnitt (`snippet`), ohne `workspace` über alle Workspaces |
| `GET /export?workspace=&collection=` | ZIP mit allen sichtbaren Szenen eines Workspaces oder einer Collection als `.excalidraw` mit Bildern, dazu `manifest.json` (6 Anfragen pro Minute; die Richtlinie des Workspaces kann Export auf Admins beschränken) |

Fehler kommen als `{"error": "<code>", "message": "<Text>"}`. Szenen und Collections ohne Zugriff sind nicht von nicht vorhandenen zu unterscheiden (beide 404).

Alle Änderungen erscheinen sofort bei allen, die die Szene geöffnet haben – der Server spielt sie wie eine weitere Person in die Live-Sitzung ein. Das Vorschaubild im Dashboard aktualisiert sich, sobald jemand die Szene im Browser öffnet.

## Elemente im Skelett-Format

Formen, Texte, Pfeile und Rahmen werden so beschrieben wie in der Excalidraw-Funktion `convertToExcalidrawElements`. Der Server erzeugt daraus vollständige Elemente mit derselben Logik wie der Editor (Textmaße mit den mitgelieferten Schriften, Pfeilbindungen, Reihenfolge):

```json
{
  "elements": [
    {
      "type": "rectangle",
      "id": "antrag",
      "x": 0,
      "y": 0,
      "width": 200,
      "height": 80,
      "label": { "text": "Antrag" }
    },
    {
      "type": "diamond",
      "id": "pruefung",
      "x": 0,
      "y": 200,
      "label": { "text": "Vollständig?" },
      "backgroundColor": "#ffec99",
      "fillStyle": "solid"
    },
    {
      "type": "arrow",
      "start": { "id": "antrag" },
      "end": { "id": "pruefung" },
      "label": { "text": "prüfen" }
    },
    {
      "type": "text",
      "x": 260,
      "y": 20,
      "text": "Eingang per Post oder E-Mail"
    }
  ]
}
```

- `type`: `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`, `frame`
- Formen: `x`, `y`, optional `width`, `height`, `label.text`, `strokeColor`, `backgroundColor`, `fillStyle`, `strokeStyle`, `roughness`
- Pfeile: `start.id` und `end.id` verweisen auf Elemente im selben Aufruf oder bereits in der Szene; Koordinaten sind dann nicht nötig
- Rahmen: `children` (ids), `name`

## Diagramme aus Knoten und Kanten

Für Abläufe, Abhängigkeiten oder Organigramme genügt die Struktur; der Server ordnet sie in Ebenen an und platziert sie rechts neben dem vorhandenen Inhalt:

```bash
curl -X POST -H "Authorization: Bearer $EXCALIDRAW_TOKEN" -H "content-type: application/json" \
  https://excalidraw.intranet.example/api/v1/scenes/$SCENE/diagram -d '{
    "direction": "LR",
    "nodes": [
      { "id": "a", "label": "Antrag", "shape": "ellipse" },
      { "id": "b", "label": "Genehmigt?", "shape": "diamond" },
      { "id": "c", "label": "Urlaub eintragen", "backgroundColor": "#b2f2bb" }
    ],
    "edges": [ { "from": "a", "to": "b" }, { "from": "b", "to": "c", "label": "ja" } ]
  }'
```

Die Antwort nennt für jeden Knoten die id des erzeugten Elements, um es später zu ändern.

## Export und Import

```bash
# exportieren (mit Bildern)
curl -H "Authorization: Bearer $EXCALIDRAW_TOKEN" \
  https://excalidraw.intranet.example/api/v1/scenes/$SCENE/content > szene.excalidraw

# als neue Szene importieren
jq '{name: "Importiert", content: .}' szene.excalidraw | curl -X POST \
  -H "Authorization: Bearer $EXCALIDRAW_TOKEN" -H "content-type: application/json" \
  --data-binary @- https://excalidraw.intranet.example/api/v1/scenes
```

Beim Ersetzen (`PUT …/content`) gewinnen geänderte Elemente gegenüber den Kopien in offenen Editoren; Elemente, die fehlen, werden gelöscht. Mit `expectedRevision` (aus `GET …/content`) schlägt das Ersetzen fehl, wenn jemand die Szene inzwischen geändert hat.

Importierte Elemente haben Grenzen, die im Editor nie erreicht werden: `x` und `y` höchstens 100 Millionen Pixel vom Ursprung, `width`, `height` und `fontSize` höchstens 1 Million, höchstens 100 000 Punkte je Linie. Darüber antwortet der Server mit 400 `invalid_elements` und nennt das Element.

## Bilder und Kommandozeile

Eine Szene oder einen Frame als Bild, etwa für Dokumentation oder Wikis:

```bash
# ganze Szene als SVG (Schriften eingebettet)
curl -H "Authorization: Bearer $EXCALIDRAW_TOKEN" \
  "https://excalidraw.intranet.example/api/v1/scenes/$SCENE/image" > szene.svg

# nur der Frame „Architektur“, als PNG in doppelter Größe, dunkel
curl -H "Authorization: Bearer $EXCALIDRAW_TOKEN" \
  "https://excalidraw.intranet.example/api/v1/scenes/$SCENE/image?format=png&scale=2&theme=dark&frame=Architektur" > architektur.png
```

| Parameter | Werte | Bedeutung |
| --- | --- | --- |
| `format` | `svg` (Standard), `png` | Bildformat |
| `frame` | Name oder id | nur dieser Frame (404 `frame_not_found`, wenn es ihn nicht gibt) |
| `theme` | `light` (Standard), `dark` | Farbschema |
| `background` | `true` (Standard), `false` | `false`: durchsichtig |
| `scale` | 1 bis 4 | Pixel pro Szenenpixel |

Bilder bis 16 Megapixel; größere lehnt der Server mit 422 `too_large` ab (dann einen Frame wählen oder `scale` verkleinern). Braucht eine Szene mehr als 20 Sekunden oder zu viel Speicher, antwortet er mit 422 `too_complex`; sind gerade acht Bilder in Arbeit, mit 503 `busy` (kurz warten, noch einmal). In PNGs fehlen eingebettete Bilder über 16 Megapixel. Höchstens 30 Bilder pro Token und Minute.

Das Kommandozeilen-Tool `excalidraw.mjs` (Node.js 20 oder neuer, ohne weitere Abhängigkeiten) liegt unter `/api/v1/cli`:

```bash
curl -o excalidraw.mjs https://excalidraw.intranet.example/api/v1/cli
export EXCALIDRAW_URL=https://excalidraw.intranet.example
export EXCALIDRAW_TOKEN=exc_...
node excalidraw.mjs scenes --collection <ID>
node excalidraw.mjs render <Szene oder Link> --frame "Folie 1" -o folie1.png
node excalidraw.mjs export <Szene> -o szene.excalidraw
node excalidraw.mjs import szene.excalidraw --collection <ID> --name "Kopie"
node excalidraw.mjs update <Szene> szene.excalidraw
node excalidraw.mjs export-all --collection <ID> -o collection.zip
```

`node excalidraw.mjs --help` zeigt alle Befehle; `--json` gibt Listen und Ergebnisse als JSON aus. Fehler enden mit einer Meldung auf stderr und dem Rückgabewert 1 (Bedienfehler 2).
