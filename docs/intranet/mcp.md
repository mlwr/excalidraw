# MCP-Server für KI-Assistenten

Der Server spricht das Model Context Protocol (MCP). KI-Assistenten, die MCP unterstützen, können damit Szenen suchen und lesen, Diagramme zeichnen, Beschriftungen ändern und kommentieren – mit den Rechten der Person, deren Token sie benutzen. Wer die Szene gerade geöffnet hat, sieht die Änderungen sofort.

- Adresse: `https://excalidraw.intranet.example/mcp`
- Transport: Streamable HTTP (zustandslos, Antworten als JSON)
- Anmeldung: `Authorization: Bearer exc_…` mit einem persönlichen Token aus dem Dashboard (**API-Tokens**). Ein Lese-Token erlaubt nur die lesenden Werkzeuge.

## Werkzeuge

| Werkzeug | Zweck |
| --- | --- |
| `list_collections` | Collections mit Zugriff |
| `search_scenes` | Szenen suchen: mit Suchbegriff in Namen, Texten der Zeichnungen und Kommentaren (mit Textausschnitt), sonst die neuesten Szenen |
| `get_scene` | Szene lesen: Formen mit Beschriftung, Pfeile mit verbundenen Elementen, Texte, Rahmen |
| `create_scene` | Leere Szene anlegen |
| `create_diagram` | Diagramm aus Knoten und Kanten anordnen und zeichnen, in einer neuen oder vorhandenen Szene |
| `add_elements` | Formen, Texte, Pfeile, Rahmen frei platzieren (Skelett-Format, siehe [REST-API](./api.md#elemente-im-skelett-format)) |
| `update_elements` | Text, Position, Größe, Farben ändern |
| `delete_elements` | Elemente löschen |
| `update_scene` | Szene umbenennen oder verschieben |
| `list_comments` | Kommentare lesen |
| `add_comment` | Kommentieren oder antworten |
| `resolve_comment` | Kommentar erledigen oder wieder öffnen |

Jedes Ergebnis enthält den Link zur Szene, damit der Assistent ihn weitergeben kann.

## Assistenten anbinden

Voraussetzung ist ein Sprachmodell mit Tool-Aufrufen (Function Calling). Bei einem selbst betriebenen Modell (z. B. Gemma oder Qwen über vLLM) muss Tool-Calling im Inferenz-Server eingeschaltet sein. Die Verbindung zum MCP-Server baut der Chat-Client auf, nicht das Modell.

**VS Code** (`.vscode/mcp.json`; das Token wird beim ersten Start abgefragt und nicht in der Datei gespeichert):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "excalidraw-token",
      "description": "Excalidraw API-Token",
      "password": true
    }
  ],
  "servers": {
    "excalidraw": {
      "type": "http",
      "url": "https://excalidraw.intranet.example/mcp",
      "headers": { "Authorization": "Bearer ${input:excalidraw-token}" }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add --transport http excalidraw https://excalidraw.intranet.example/mcp --header "Authorization: Bearer $EXCALIDRAW_TOKEN"
```

**Andere Clients** (z. B. Open WebUI, LibreChat): als MCP-Server vom Typ „Streamable HTTP“ mit der Adresse oben eintragen und den Header `Authorization: Bearer <Token>` setzen. Clients, die nur das ältere SSE-Verfahren oder nur lokale stdio-Server können, brauchen einen Adapter.

Der Dialog **API-Tokens** im Dashboard zeigt unter „So wird ein Token benutzt“ eine fertige Konfiguration mit der eigenen Adresse.

## Beispiele für Aufträge

- „Zeichne den Ablauf unseres Urlaubsantrags als Diagramm von links nach rechts: Antrag, Prüfung durch die Führungskraft, bei Ja Eintrag im Kalender, bei Nein Rückmeldung.“
- „Lies die Szene ‚Zielarchitektur 2027‘ und fasse zusammen, welche Systeme miteinander verbunden sind.“
- „Ergänze in ‚Onboarding‘ nach ‚Laptop bestellen‘ einen Schritt ‚Zugänge beantragen‘ und kommentiere ihn mit der Frage, wer zuständig ist.“

## Sicherheit

- Der MCP-Server prüft jede Aktion mit denselben Rechten wie die App; ein Token sieht nie mehr als seine Person.
- Tokens lassen sich im Dashboard jederzeit widerrufen und laufen spätestens nach `API_TOKEN_MAX_DAYS` ab. Sie wirken nur, solange sich ihre Person regelmäßig anmeldet (`API_TOKEN_LOGIN_MAX_AGE_DAYS`), und enden, wenn Keycloak ihr den Zugang entzieht.
- Mit `API_REQUIRED_ROLE` dürfen nur Personen mit einer bestimmten Keycloak-Rolle Tokens anlegen und benutzen; mit `MCP_ENABLED=false` ist der MCP-Server aus, die REST-API bleibt.
- Inhalte gehen nur an den Client, der das Token benutzt. Wohin dieser sie weitergibt (z. B. an ein Sprachmodell), entscheidet seine Konfiguration – im Intranet an das interne Modell.
