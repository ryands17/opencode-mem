# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)
[![Website](https://img.shields.io/badge/website-opencode--mem.zhafron.my.id-blue)](https://opencode-mem.zhafron.my.id)
[![Docs](https://img.shields.io/badge/docs-opencode--mem.zhafron.my.id%2Fdocs-blue)](https://opencode-mem.zhafron.my.id/docs/)

![OpenCode Memory Banner](../pics/banner.png)

Sprachen: [🇬🇧](../../README.md) | **🇩🇪** | [🇨🇳](./README.zh.md) | [🇸🇦](./README.ar.md) | [🇹🇷](./README.tr.md) | [🇳🇱](./README.nl.md)

Ein persistentes Speichersystem für KI-Coding-Agenten, das langfristige Kontextbeibehaltung über Sitzungen hinweg mittels Vektorsuche ermöglicht, die von einem libSQL-Server (sqld) betrieben wird.

## Kernfunktionen

- **Datenbank:** ein libSQL-Server (`sqld`) hält die Memories mit nativer Vektorsuche; keine separate Vektordatenbank und keine nativen Bindings.
- **Intelligente promptbasierte Speicherextraktion (auto-capture):** Wenn eine Sitzung inaktiv wird, wandelt eine KI-Anfrage im Hintergrund die technische Arbeit in persistente Projektspeicher um.
- **Automatischer Abruf:** Relevante Speicher und das Benutzerprofil werden in den Kontext des Modells eingefügt (`chatMessage`).
- **Automatisches Lernen des Benutzerprofils:** eine projektübergreifende Zusammenfassung Ihrer Vorlieben, Muster und Workflows.
- **Speicherpflege:** smarte Deduplizierung, optionales update-on-capture und optionale dreaming-Konsolidierung mit wiederherstellbarem Papierkorb.
- **Multi-Provider-KI-Unterstützung:** jeder in OpenCode konfigurierte Provider (`opencodeProvider` / `opencodeModel`) oder eine manuelle API: OpenAI Chat Completions, OpenAI Responses, Anthropic, MiniMax, OrcaRouter, Atlas Cloud, Cheaper Inference, API Route, Runcrate, CloudGPU.
- **Embeddings:** jede OpenAI-kompatible Embeddings-API (erforderlich); kein lokaler Modell-Download und keine GPU nötig.
- **Vollständige Web-UI:** einheitliche memory–prompt timeline, Benutzerprofil, Skill-Bibliothek, Markdown vault und Statistiken zum Systemzustand, mit optionaler HTTP Basic Auth.
- **Integrierter Datenschutz:** `<private>`-Tags und Schwärzung von Zugangsdaten vor der Erfassung.
- **Portabilität:** optionales Markdown vault-Backend sowie `export` / `import` / `migrate` des `memory`-Tools für verschobene oder kopierte Projekte.

## Voraussetzungen

opencode-mem speichert Memories in einem **libSQL-Server (`sqld`)**, der über HTTP/WebSocket durch den reinen JS-Transport `@libsql/client/web` erreichbar ist. Er nutzt `F32_BLOB`-Vektoren und exakte Cosinus-Suche über `vector_distance_cos`. Es gibt **keine nativen Bindings und keine lokale ML-Laufzeit**, sodass das Plugin überall läuft, wo Bun läuft — einschließlich Intel Macs (`darwin/x64`). Du brauchst einen laufenden sqld-Server (siehe [Erste Schritte](#erste-schritte)) und einen Remote-Embeddings-Endpoint.

**Empfohlene Laufzeitumgebung:**

- Bun
- Standard-OpenCode-Plugin-Umgebung
- Docker (oder eine andere Möglichkeit, einen `sqld`-Server zu betreiben) für die Memory-Datenbank
- Eine remote OpenAI-kompatible Embeddings-API und ein Key (`embeddingApiUrl` + `embeddingApiKey`)
- Bei Quell-/Entwicklungsinstallationen vor dem Bauen oder Testen `bun install` ausführen. Das veröffentlichte Plugin-Paket installiert seine Laufzeitabhängigkeiten automatisch über OpenCode.

**In CI getestete Plattformen:** Linux, Windows, macOS auf Apple Silicon (`darwin/arm64`) und Intel (`darwin/x64`). sqld und Remote-Embeddings haben keine plattformspezifischen nativen Bindings.

**Hinweise:**

- Vektor-Embeddings werden direkt in sqld gespeichert und durchsucht; Inserts speichern `F32_BLOB`-Vektoren für exaktes Cosinus-Ranking.
- Die Vektorsuche verwendet exakte Cosinus-Distanz über `vector_distance_cos` (kein DiskANN / approximativer Index), mit optionalem Keyword-Hybrid-Ranking, wenn ein Query-String angegeben ist.
- Session-Lookups nutzen eine indexierte Spalte `session_id` (nachgezogen aus `metadata.sessionID` bei Schema v2).
- Auto-Capture und Lernen des Benutzerprofils erfordern einen KI-Provider, der strukturierte/Tool-Call-Ausgabe liefern kann. Speicher-Suche/Hinzufügen/Listen funktionieren auch ohne Auto-Capture-Provider-Konfiguration.
- Alle Memories einer Installation liegen in einer sqld-Datenbank, logisch partitioniert nach Container-Tag (Projekt/User). `storagePath` enthält nur lokale Caches und Markdown-Vault-Indizes.

### Hardware- / Ressourcenanforderungen

opencode-mem benötigt **keine** GPU und keine lokale ML-Laufzeit — die Embeddings kommen von deiner konfigurierten Remote-API, sodass keine Modelle heruntergeladen oder im Speicher gehalten werden.

| Workload                                               | Typische zusätzliche Ressourcen                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Embeddings** (`embeddingApiUrl` + `embeddingApiKey`) | Vernachlässigbarer lokaler RAM — nur das Plugin; die Embedding-Arbeit passiert bei der API.                                       |
| **Datenbank / Plugin**                                 | Die Memories liegen im sqld-Server. Die lokale Datenträgernutzung unter `storagePath` beschränkt sich auf Caches und Markdown-Vault-Indizes. |

Siehe [Embeddings wählen / konfigurieren](#embeddings-wählen--konfigurieren).

### Upgrade von Legacy-SQLite-Shards

Frühere Versionen hielten jeden Memory-Shard in einer eingebetteten Turso-Datenbankdatei unter `storagePath`. Diese Engine (und ihr `multiprocess_wal`, die WAL-Index-Wiederherstellung, die DiskANN-Konvertierung und dateibasierte Migrationsmarker) wird nicht mehr verwendet: Memories liegen jetzt in einem einzelnen sqld-Server und werden nach Container-Tag partitioniert. Wenn du ein neueres Plugin gegen eine alte Installation startest, werden diese alten Dateien nicht konvertiert — starte sqld, richte `sqldUrl` darauf und importiere deine Memories mit den `export` / `import`-Befehlen des `memory`-Tools, wenn du sie übernehmen möchtest.

Wenn gespeicherte Vektoren mit den konfigurierten Embeddings inkompatibel werden (z. B. nach Änderung von `embeddingDimensions`), werden Writes in diesen logischen Shard blockiert. Nutze die Re-Embed-Migration der Web-UI, um einen Ersatz neu zu bauen und zu verifizieren; der vorherige Shard wird vor dem Tausch in sqld archiviert. `sqldUrl` auf einen anderen Server oder eine andere Datenbank zu richten, ergibt ebenfalls einen sauberen Store, ohne den alten anzutasten.

## Schema-Migrationen

Memory-Tabellen in sqld werden mit geordneten, pro Label versionierten Migrationen aktualisiert, die in der Tabelle `_opencode_mem_schema_versions` nachgehalten werden (implementiert in `src/services/turso/schema-migrations.ts`). Hilfsdaten (Skills, User-Prompts, User-Profile, KI-Sessions) nutzen denselben Mechanismus mit einem eigenen Label. Migrationen sind idempotent: Beim Start des Plugins werden nur ausstehende Versionen angewendet.

## Erste Schritte

### sqld einrichten

Memories liegen in einem [libSQL-Server (`sqld`)](https://github.com/tursodatabase/libsql). Der schnellste Weg, einen zu betreiben, ist Docker mit einem benannten Volume, damit die Daten Container-Neustarts überleben:

```bash
docker run -d --name opencode-mem-sqld \
  -p 8080:8080 \
  -v opencode-mem-sqld-data:/var/lib/sqld \
  -e SQLD_NODE=primary \
  ghcr.io/tursodatabase/libsql-server:latest
```

Alternativ [`scripts/sqld-compose.yml`](scripts/sqld-compose.yml) nutzen: `docker compose -f scripts/sqld-compose.yml up -d`.

Prüfe, ob der Server unter `http://127.0.0.1:8080/health` gesund ist. Das Plugin defaultet auf `sqldUrl: "http://127.0.0.1:8080"`, sodass diese lokale Einrichtung keine Config-Änderung braucht. Für einen Remote-Server `sqldUrl` setzen und, falls er Authentifizierung verlangt, `sqldAuthToken` (akzeptiert `env://…`- und `file://…`-Referenzen).

Für einen lokalen Start ohne Konfiguration `"autoStartSqld": true` setzen. Mit dem Standard-`sqldUrl` startet das Plugin den Container `opencode-mem-sqld` automatisch beim Laden (das Image wird beim ersten Mal gepullt), nutzt ihn bei späteren Ladevorgängen wieder und stoppt oder entfernt ihn nie — die Memories bleiben im Volume `opencode-mem-sqld-data` erhalten. Docker muss laufen. Ein benutzerdefinierter oder entfernter `sqldUrl` wird nicht angefasst.

Behalte das benannte Volume beim Upgrade oder Neuerstellen des Containers — das Entfernen löscht alle Memories. Sichere es (oder nutze `memory export`), bevor du destruktive Operationen durchführst. Du brauchst außerdem einen Remote-Embeddings-Endpoint; siehe [Embeddings wählen / konfigurieren](#embeddings-wählen--konfigurieren).

Für OpenCode v2 das Paket zur nativen `plugins`-Liste hinzufügen:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode lädt den `./tui`-Companion des Pakets automatisch, damit
Auto-Capture- / Profil- / Fehler-Toasts in der TUI erscheinen (Server-Plugins
können `ui.toast` nicht direkt aufrufen). Du brauchst keinen zweiten Eintrag in
`plugins`. Wenn du eine reine CLI-TUI gegen einen Remote-OpenCode-Server
betreibst, registriere `opencode-mem/tui` in der Plugin-Liste dieser CLI (z. B.
`cli.json`), damit der Companion Toast-RPC-Events abonnieren kann.

Für OpenCode v1 den Standard-Entrypoint in der Konfiguration unter
`~/.config/opencode/opencode.json` hinzufügen:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

Mit `@latest` (oder einem Semver-Bereich) und `autoUpdate: true` in `opencode-mem.jsonc` (Standard) löscht das Plugin den von OpenCode zwischengespeicherten Install, sobald eine neuere npm-Version verfügbar ist, und bittet dich um einen Neustart. Gepinnte Versionen wie `opencode-mem@2.26.0` werden nie automatisch aktualisiert.

### Automatischer Speicher-Kontext unter OpenCode v2

Das v2-Plugin liefert automatischen Speicher-Kontext über den Systemkontext des Modells.
Diese Blöcke werden nicht zum verfassten User-Prompt hinzugefügt und nicht im Chat-Transkript gespeichert.
Mit `chatMessage.injectOn: "first"` (der Standard) bleibt der initiale Kontext der Sitzung
über User-Turns und Modell-Schritte erhalten. Mit `"always"` wird er bei jedem
verfassten User-Turn aktualisiert.

Nach einem Host- oder Plugin-Neustart baut eine fortgesetzte Sitzung ihren Kontext beim
nächsten Modell-Request aus dem aktuellen Speicher neu auf, auch wenn kein neuer User-Prompt eintrifft.
Der neu aufgebaute Kontext kann vom Original abweichen, da sich Memories und Profil weiterentwickeln.
Die Wiederherstellung erzeugt keinen synthetischen User-Prompt und speichert keine zweite Kopie des
Speichertexts im OpenCode-Plugin-Storage. Compaction invalidiert den zwischengespeicherten automatischen
Kontext; die bestehende Compaction-Memory-Wiederherstellung läuft weiterhin.

### Lokalen Checkout verwenden

Um das Plugin aus einem lokalen Quell-Checkout statt aus dem npm-Release zu betreiben, im Checkout `bun install && bun run build` ausführen und die `plugins`-Liste auf das Checkout-Verzeichnis zeigen:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Auf die Paketwurzel zeigen, nicht auf `dist/` oder eine einzelne Datei. OpenCode löst ein Verzeichnis-Plugin über Fallback auf `<directory>/index` auf (OpenCode liest bei aktuellem Stand für eine Pfadangabe nicht `package.json` `exports`/`main`), daher liefert dieses Repository ein schlankes Root-`index.js`, das den gebauten v2-Entrypoint aus `dist/plugin.js` re-exportiert, sowie ein Root-`tui.js`, das `dist/tui.js` für den TUI-Companion re-exportiert. Ein Pfad zu einer Datei wird abgelehnt (`configured plugin path must be a directory`), und ein Verzeichnis ohne Root-`index.js` wird stillschweigend übersprungen.

### Optionale Datenbankverschlüsselung im Ruhezustand

Das Plugin verwaltet die Datenbankverschlüsselung nicht mehr selbst — die alten Optionen `databaseEncryptionEnabled`, `databaseEncryptionKey` und `databaseEncryptionCipher` wurden entfernt. Memories liegen in deinem sqld-Server, also schütze sie auf dieser Ebene: betreibe sqld auf einem verschlüsselten Volume, beschränke den Netzwerkzugriff auf `sqldUrl` und setze `sqldAuthToken`, wenn der Server Authentifizierung verlangt. Der Token akzeptiert `env://…`- und `file://…`-Referenzen, damit er nicht im Klartext in der Config-Datei stehen muss.

**Windows:** `%USERPROFILE%\.config\opencode\opencode.json` verwenden (z. B. `C:\Users\<you>\.config\opencode\opencode.json`). Dieses Plugin liest **nicht** `%APPDATA%` oder `%LOCALAPPDATA%` für seinen OpenCode-Plugin-Eintrag — die Datei unter `.config\opencode` im User-Profil ablegen und OpenCode neu starten. Erscheint das Plugin nicht, den Pfad prüfen und erneut neu starten.

Das Plugin wird beim nächsten Start automatisch heruntergeladen.

## Tägliche Nutzung

Du musst OpenCode **nicht** bitten, Dinge zu „merken“, damit das Plugin funktioniert. Mit den Standardeinstellungen baut sich der Speicher auf, während du arbeitest.

### Typischer Tagesablauf

1. Plugin aktivieren (siehe [Erste Schritte](#erste-schritte)) und OpenCode neu starten.
2. KI-Provider für Auto-Capture konfigurieren — empfohlen: `opencodeProvider` + `opencodeModel` (oder `"opencodeModel": "inherit"`). Details unter [Auto-Capture-KI-Provider](#auto-capture-ki-provider).
3. Normal in OpenCode arbeiten. Wenn eine Sitzung idle wird, extrahiert Auto-Capture merkenswerten technischen Kontext und speichert ihn.
4. In späteren Sitzungen werden relevante Memories in den Kontext injiziert (siehe `chatMessage` / Compaction-Einstellungen). Im Web-UI unter `http://127.0.0.1:4747` browsen oder bearbeiten.
5. Das `memory`-Tool nutzen, wenn etwas sofort gespeichert oder abgerufen werden soll (siehe [Verwendungsbeispiele](#verwendungsbeispiele)).

### Automatischer vs. manueller Speicher

| Ansatz                                                  | Wann er läuft                                    | Was du tust                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Auto-Capture** (`autoCaptureEnabled: true`, Standard) | Nach Gesprächsrunden, wenn die Sitzung idle wird | Nichts — die Extraktion ist automatisch                                                            |
| **Manuell** `memory`-Tool / Befehle                     | Auf Abruf                                        | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import`, `help` |

Manuelle Suche/Hinzufügen/Listen funktionieren auch, wenn für Auto-Capture kein Provider konfiguriert ist. Auto-Capture und Lernen des Benutzerprofils brauchen einen Provider, der strukturierte/Tool-Call-Ausgabe liefern kann.

### Speicher vs. AGENTS.md vs. Skills

| In **memory** speichern                                                                      | In **AGENTS.md** / statischen Docs speichern                     | Als **Skills** speichern (Web-UI / `skills.db`)                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Projektspezifische Entscheidungen, Bug-Muster, „wir haben X versucht und es ist gescheitert“ | Stabile Regeln und Workflows, die sich selten ändern             | Wiederverwendbare Prozeduren, die der Agent bei Bedarf lädt     |
| Über Sitzungen hinweg entdeckte Benutzerpräferenzen                                          | Immer gültige Coding-Konventionen und Prozesse                   | Team-editierbare Skill-Packs über denselben Storage             |
| Fakten, die dir über Chats hinweg folgen sollen                                              | Anweisungen, die jeder Agent unabhängig von Retrieval sehen soll | OpenCode-natives `skill`-Tool (V2-Plugin-Bridge)                |

Faustregel: dauerhafte Always-on-Projektanweisungen → `AGENTS.md`; wachsender Arbeitskontext → Speicher; wiederverwendbare On-Demand-Prozeduren → **Skills**.

#### Shared Skills (V2)

- Skills im Web-Explorer anlegen/bearbeiten (**Skills**-Tab unter `/skill-library`).
- Persistiert in `skills.db` unter dem Plugin-Storage-Pfad (nicht als Memory-Vektoren).
- Unter OpenCode **V2** registriert das Plugin aktivierte Skills über `ctx.skill.transform`, sodass der Agent sie mit dem nativen `skill`-Tool laden kann.
- Optionaler HTTP-Katalog für andere OpenCode-Instanzen: `"skills": ["http://127.0.0.1:4747/skills/"]` (liefert `/skills/index.json` und `/skills/<id>/<id>.md` — getrennt vom UI-Pfad).
- REST: `GET/POST /api/skills`, `GET/PUT/DELETE /api/skills/:id`.

### Health-Stats

Der **Stats**-Tab der Web-UI (unter `/stats`) zeigt auf einen Blick die Gesundheit des Memory-Systems: Totals pro Scope, Memory-Zählungen pro Shard mit Warnungen zu veralteten/fehlenden Shards und einem Proxy für Same-Tag-Duplikate, die aktive User-Profil-Version sowie eine 14-Tage-Aktivitätsserie (Captures, übersprungene Captures, Profil-/Compaction-Injections und nach Message gebucketete Fehler) aus den strukturierten Plugin-Logs in `~/.opencode-mem/`. Nur lesend — `GET /api/stats` — und degradiert pro Abschnitt, wenn eine Datenbank fehlt, sodass bei Incidents weiter berichtet wird.

### Intelligente promptbasierte Speicherextraktion

Dieser Begriff in der Feature-Liste ist **Auto-Capture**: Nach einem Gespräch fasst eine Hintergrund-KI-Anfrage technische Arbeit zusammen und speichert sie als Memory. Es ist kein spezieller Prompt von dir nötig. Es nutzt `opencodeProvider` / `opencodeModel`, wenn gesetzt, sonst den manuellen `memoryProvider`-Fallback.

### Benutzerprofil

Das **Benutzerprofil** ist eine separate, projektübergreifende Zusammenfassung, wie du gerne arbeitest (Präferenzen, Gewohnheiten). Es wird in einem Intervall aktualisiert (`userProfileAnalysisInterval`, Standard alle 10 analysierten Prompts), in der Profilansicht der Web-UI angezeigt und über `memory({ mode: "profile" })` lesbar. Für den Normalbetrieb füllst du es nicht von Hand — das Profil-Lernen füllt es, sobald ein Provider bereit ist. Die Ausgabesprache folgt `autoCaptureLanguage` (Standard `"auto"`, spiegelt die Sprache deiner Prompts), dieselbe Einstellung wie für auto-erfasste Memories.

**„No profile found. Keep chatting to build your profile.“** ist der erwartete Leerzustand, kein Absturz. Profil-Lernen braucht:

1. Laufendes Auto-Capture mit erreichbarem Provider (`opencodeProvider` + `opencodeModel`, oder vollständiger manueller Fallback mit `memoryModel` + `memoryApiUrl`).
2. Genug Sitzungs-Prompts seit der letzten Analyse — mindestens `userProfileAnalysisInterval` (Standard **10**).
3. Dass dieser Provider strukturierte/Tool-Call-Ausgabe unterstützt (gleiche Anforderung wie Auto-Capture).

Wenn du eine Weile gechattet hast und die Meldung weiterhin siehst, prüfe in den Logs, ob Auto-Capture tatsächlich feuert und der konfigurierte Provider erfolgreich ist (fehlgeschlagene Profilanalyse versteckt sich nicht mehr hinter einem generischen Leerzustand, wenn der Provider fehlerhaft ist).

### Web-UI

Öffne `http://127.0.0.1:4747`, um die memory–prompt timeline zu browsen, Captures zu prüfen und das Benutzerprofil zu verwalten. Die UI hat fünf Ansichten: **Project memories** (`/project-memories`), **User profile** (`/user-profile`), **Skill library** (`/skill-library`), **Markdown vault** (`/markdown-vault`) und **Stats** (`/stats`). Ändere den Port mit `webServerPort`, oder setze `webServerEnabled: false`, um ohne die Web-UI zu arbeiten. Bindest du den Server über Loopback hinaus, siehe [Web-UI HTTP Basic Auth](#web-ui-http-basic-auth).

## Verwendungsbeispiele

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture decisions" });
memory({ mode: "search", query: "architecture decisions", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
memory({ mode: "export", outputPath: "./memories.json" });
memory({ mode: "import", inputPath: "./memories.json" });
```

Web-Oberfläche unter `http://127.0.0.1:4747` für visuelle Speicherverwaltung und -browsing.

**Netzwerk-Binding-Sicherheit:** `webServerHost` auf `127.0.0.1` lassen, sofern du die UI nicht absichtlich exponierst. Binding auf `0.0.0.0` (oder jeden Non-Loopback-Host) erfordert `webServerApiToken`; alle `/api/*`-Requests müssen dann `Authorization: Bearer <token>` oder `X-Opencode-Mem-Token` senden. Die UI mit `?apiToken=<token>` öffnen, damit der Browser den Token speichert und mitsendet.

Dimensionsmigrationen erzeugen zuerst jedes neue Embedding, importieren sie in einen temporären indexierten Shard, verifizieren die Zeilenanzahl und ersetzen erst dann die Originaldatei. Fehlgeschlagene Migrationen lassen den Quell-Shard unberührt.

## Wichtige Konfiguration

Konfiguration unter `~/.config/opencode/opencode-mem.jsonc`:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (dasselbe Verzeichnis `.config\opencode` wie oben — nicht AppData). Der Standard-Storage löst sich zu `%USERPROFILE%\.opencode-mem\data` auf (die `~`-Form expandiert unter Windows ebenfalls zu deinem User-Home).

Das Plugin legt beim ersten Start eine voll kommentierte Vorlage unter diesem Pfad an. Für jede Einstellung und jeden Kommentar siehe [`opencode-mem.example.jsonc`](../../opencode-mem.example.jsonc).

Häufig angepasste Top-Level-Optionen:

| Option                                                                | Standard                        | Funktion                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sqldUrl`                                                             | `"http://127.0.0.1:8080"`       | URL des libSQL-Servers (`sqld`), der die Memories hält.                                                                                    |
| `sqldAuthToken`                                                       | _(leer)_                        | Auth-Token für sqld; akzeptiert `env://…`- / `file://…`-Referenzen.                                                                         |
| `autoStartSqld`                                                       | `false`                         | Startet den Standard-sqld-Container beim Laden des Plugins (Docker erforderlich); wird bei einem benutzerdefinierten `sqldUrl` ignoriert.  |
| `storagePath`                                                         | `"~/.opencode-mem/data"`        | Lokale Caches und Markdown-Vault-Indizes; die Memories selbst liegen in sqld.                                                              |
| `webServerEnabled` / `webServerPort` / `webServerHost`                | `true` / `4747` / `"127.0.0.1"` | Schalter, Port und Bind-Adresse des Web-UI-Servers.                                                                                        |
| `autoCaptureEnabled`                                                  | `true`                          | Fasst inaktive Sessions zu Memories zusammen (benötigt einen Provider, siehe [Auto-Capture AI Provider](#auto-capture-ki-provider)).       |
| `similarityThreshold` / `maxMemories`                                 | `0.6` / `10`                    | Minimaler Ähnlichkeitswert und maximale Anzahl an Ergebnissen für die Memory-Suche.                                                        |
| `injectProfile`                                                       | `true`                          | Fügt das User profile (Präferenzen, Muster, Workflows) in den KI-Kontext ein.                                                             |
| `deduplicationEnabled` / `deduplicationSimilarityThreshold`           | `true` / `0.9`                  | Erkennt und entfernt doppelte Memories.                                                                                                    |
| `autoCleanupEnabled` / `autoCleanupRetentionDays`                     | `true` / `30`                   | Löscht höchstens einmal täglich Prompts, die älter als der Aufbewahrungszeitraum sind, und Memories, die innerhalb dieses Zeitraums nicht aktualisiert wurden. Angepinnte Memories bleiben erhalten. |
| `showAutoCaptureToasts` / `showUserProfileToasts` / `showErrorToasts` | `true`                          | Toasts für auto-capture, Profil-Updates und Fehler.                                                                                        |
| `autoUpdate`                                                          | `true`                          | Leert die zwischengespeicherte Installation von OpenCode, wenn ein neueres npm-Release verfügbar ist.                                      |

### Markdown-Vault-Backend (`memoryBackend`)

Standardmäßig liegen Memories nur in sqld. Optional kannst du einen **generischen Markdown-Ordner** als Source of Truth setzen (Obsidian-/Raneto-kompatible reine `.md`-Dateien — keine Obsidian-spezifische Integration):

```jsonc
{
  "memoryBackend": "markdown",
  "markdownPath": "~/Documents/LLM-Wiki",
}
```

| Schlüssel       | Standard     | Was er tut                                                                                                                                         |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryBackend` | `"database"` | `"database"` hält den Inhalt in sqld. `"markdown"` nutzt alle `.md`-Dateien unter `markdownPath` als Source of Truth.                                  |
| `markdownPath`  | —            | Erforderlich bei `memoryBackend: "markdown"`. Absoluter oder `~/…`-Pfad zum Vault-Ordner. Kein separates Memory-Unterverzeichnis — der Pfad _ist_ der Store. |

Wenn Markdown-Modus aktiv ist:

- Vom Plugin erzeugte Memories werden als `{id}.md` mit YAML-Frontmatter + Body geschrieben.
- Vorhandene Notizen im Ordner (beliebiger Markdown-Seitenstil) werden importiert/indexiert; sqld ist nur ein neu aufbaubarer Semantic-Search-Index.
- Datei-Adds/Edits/Deletes werden beobachtet und neu indexiert; die Web-UI zeigt nur in diesem Modus eine **Markdown**-Sidebar-Seite (Status, Dateiliste, Reindex).
- Der Wechsel zu Markdown baut den Index aus dem Ordner neu auf. Reine Datenbankeinträge ohne passende Datei werden nur nach einem lesbaren, vollständigen Scan eines nicht leeren Vaults entfernt. Exportiere zuerst mit `memory export`, wenn du alte Datenbank-Memories behalten möchtest.
- Der Abgleich überspringt das Löschen und gibt eine Warnung aus, wenn der Vault fehlt, nicht lesbar ist, nur teilweise gescannt oder verarbeitet wurde oder keine Markdown-Dateien enthält; bereits indexierte Memories bleiben erhalten. Stelle den Vault wieder her oder behebe das Problem und indexiere ihn erneut. Um die indexierte Memory der letzten Datei absichtlich zu entfernen, lösche diese Memory ausdrücklich über das Tool oder die Web-UI.
- Bei einem funktionierenden, nicht leeren Vault werden indexierte Memories ohne zugehörige Datei weiterhin endgültig gelöscht. Exportiere die Daten oder erstelle vorher ein Backup: Diese Schutzmaßnahmen ersetzen kein Backup und erkennen keine unvollständige Synchronisierung, die wie ein funktionierender, nicht leerer Vault aussieht.

### Erfassung und Injection von Chat-Nachrichten (`chatMessage`)

Diese Einstellungen liegen unter dem Schlüssel `chatMessage` in `~/.config/opencode/opencode-mem.jsonc`:

| Option                                                 | Standard           | Was sie tut                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                              | `true`             | Verfasste User-Prompts erfassen und Speicher-Kontext injizieren.                                                                                                                                                                                                                                                                |
| `injectOn`                                             | `"first"`          | Bei `recall: "recent"`: Kontext bei der ersten User-Nachricht oder bei `"always"` jedem Turn. Bei `recall: "relevant"` / `"both"` wird der Kontext bei jedem verfassten Turn neu geladen (Issue #460).                                                                                                                          |
| `recall`                                               | `"relevant"`       | Auswahl injizierter Memories: `"relevant"` bettet die User-Nachricht ein und sucht per Vektor (jeder Turn); `"recent"` behält die Legacy-Newest-N-Liste; `"both"` bevorzugt relevant und füllt mit recent auf.                                                                                                                 |
| `recallScope`                                          | `"default"`        | Scope für Auto-Recall: `"default"` folgt `memory.defaultScope`, oder `"project"` / `"all-projects"`. Bei All-Projects erhalten Treffer aus dem aktuellen Projekt einen kleinen Similarity-Boost.                                                                                                                                |
| `similarityThreshold`                                  | (Top-Level)        | Optionale Untergrenze pro Injection; sonst wird das Top-Level-`similarityThreshold` verwendet.                                                                                                                                                                                                                                  |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / —   | Wie viele Memories der injizierte Kontext hält, ob Memories aus der aktuellen Sitzung ausgeschlossen werden, und optionaler Alters-Cutoff in Tagen.                                                                                                                                                                             |
| `filterInjectedPrompts`                                | `true`             | Prompt-Text überspringen, der vom Host oder anderen OpenCode-Plugins injiziert wurde (System-Reminders, Orchestrierungsanweisungen, Background-Task-Benachrichtigungen), damit er nie so gespeichert wird, als hätte ihn der User getippt.                                                                                      |
| `injectionMarkers`                                     | Built-ins          | Zusätzliche Marker zur Erkennung injizierter Blöcke; werden zur Built-in-Liste hinzugefügt, ersetzen sie nie.                                                                                                                                                                                                                   |
| `captureChildSessions`                                 | `false`            | Prompts aus Orchestrator-Child-Sitzungen erfassen (Sitzungen mit `parentID`, z. B. OpenCode-Task-/Subagent-Children). Deren „User“-Nachrichten schreibt der Parent-Agent, nicht du — daher werden sie standardmäßig nicht gespeichert, auto-captured, für Profil-Lernen genutzt oder mit injiziertem Speicher-Kontext versehen. |

Ausschlüsse nach Sitzung und Alter werden vor dem Limit für injizierte Memories
angewendet. Ausgeschlossene Memories belegen daher keine Plätze, die für geeignete
Memories verfügbar wären. Mit `chatMessage.maxMemories` auf `0` wird die Injektion
von Projekt-Memories deaktiviert; das Nutzerprofil kann weiterhin injiziert werden,
wenn es aktiviert ist.

Injizierte Memory-Tags kennzeichnen `selection="recent"` oder `selection="semantic"`.
Recent-Auswahlen (einschließlich Fallback und Recent-Auffüllung bei `both`) haben keinen
numerischen Score. Semantic-Auswahlen tragen, sofern verfügbar, einen endlichen `retrieval_score`;
dies ist ein Ranking-Signal, das den Boost für das aktuelle Projekt enthalten kann, keine
Wahrscheinlichkeit für Relevanz oder sachliche Richtigkeit. Fehlende oder ungültige Scores
werden weggelassen. Dies ersetzt das frühere Prompt-Attribut `relevance="...%"`, ohne
Auswahl, Reihenfolge, Inhalt oder Herkunft der Memories zu ändern. Compaction behält ihr
bisheriges Format.

Wenn semantischer Recall fehlschlägt (z. B. weil Embedding nicht verfügbar ist), fallen
`relevant` und `both` auf die bestehende Recent-Liste zurück, mit denselben Einschränkungen
für Scope, Anzahl, Sitzung und Alter. Eine erfolgreiche Suche ohne geeignete Treffer bleibt
bei `relevant` leer; `both` füllt wie gewohnt mit recent auf. Warnungen zu Partial-Shards
lösen keinen Fehler-Fallback aus. Schlägt auch der Recent-Fallback fehl, bleibt der Recall
leer und nicht fatal. Das Fallback-Verhalten bei fehlender Query und das Neuladen pro Turn
bleiben unverändert.

### Update-on-capture (optional)

Opt-in-Pfad, der Memories aktuell hält, wenn sich Fakten ändern. Bei
`updateOnCaptureEnabled: true` bettet Auto-Capture die neue Summary ein, sucht ähnliche
Memories oberhalb von `updateOnCaptureSimilarityThreshold` (Standard `0.75`) und lässt das
Capture-Modell zwischen `add`, `update` (in-place überschreiben) und `supersede` (neu
speichern + alt soft-deleten in den Papierkorb) wählen. Gepinnte Memories werden übersprungen.
Standard ist aus, damit bestehende Installationen add-only bleiben.

```jsonc
"updateOnCaptureEnabled": true,
"updateOnCaptureSimilarityThreshold": 0.75,
"updateOnCaptureMaxCandidates": 5,
```

Tipp: Bei `Xenova/nomic-embed-text-v1` verbessert `embeddingUseTaskPrefixes: true` (und ggf.
ein niedrigeres Recall-`similarityThreshold`) oft die Trefferqualität bei längeren Memories.
Prefixes bleiben standardmäßig opt-in.

### Dreaming (optionale Memory-Konsolidierung)

Opt-in-Hintergrundlauf, der **verwandte** Memories findet (über `dreaming.relatedThreshold`,
Standard `0.75`, unabhängig von `deduplicationSimilarityThreshold`), sie über
`opencodeProvider`/`opencodeModel` mit `merge` / `update` / `supersede` / `keep` / `flag`
(Widersprüche) konsolidiert und ersetzte Einträge soft-deleten (wiederherstellbarer
Papierkorb). Gepinnte Memories bleiben unberührt. Mit `dreaming.crossProject: true` (oder
`memory.defaultScope: "all-projects"`) gruppiert Dreaming über Projekt-Tags; User-Scope
bleibt getrennt. Konfiguration unter `dreaming` in `opencode-mem.jsonc` (`enabled` Standard
`false`). Die Web-UI bietet **Papierkorb** und **Dreaming**. Soft-gelöschte Zeilen werden
nach `dreaming.trashRetentionDays` beim Cleanup hart bereinigt.

### Embeddings wählen / konfigurieren

Embeddings treiben die Ähnlichkeitssuche für Memories und das Benutzerprofil. Konfiguration in `~/.config/opencode/opencode-mem.jsonc`. **Remote-Embeddings sind das einzige Backend** — das lokale ONNX/transformers-Modell wurde entfernt, weil seine nativen Bindings nicht für jede Plattform verfügbar sind. Sowohl `embeddingApiUrl` als auch `embeddingApiKey` sind erforderlich: Fehlt einer davon, zeigt das Plugin einen Startfehler an und weigert sich, Memories zu speichern oder zu durchsuchen.

**Remote (OpenAI-kompatibel):** das Plugin ruft `{embeddingApiUrl}/embeddings` mit einem Bearer-Token auf. `embeddingApiKey` akzeptiert dieselben Secret-Formate wie `memoryApiKey` (`literal`, `env://…`, `file://…`). Der Endpoint muss Vektoren mit konsistenter Dimension liefern; setze `embeddingDimensions`, falls dein Endpoint die Dimension nicht in einem Built-in-Preset meldet.

| Schlüssel                  | Rolle                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `embeddingApiUrl`          | **Erforderlich.** Basis-URL einer OpenAI-kompatiblen Embeddings-API (kein trailing Path über `/v1` hinaus).                              |
| `embeddingApiKey`          | **Erforderlich.** API-Key für diesen Endpoint; akzeptiert `env://…`- / `file://…`-Referenzen.                                             |
| `embeddingModel`           | Modellname, den dein Endpoint ausliefert. Standard: `Xenova/nomic-embed-text-v1` (wird auch für die Dimensionssuche genutzt).            |
| `embeddingDimensions`      | Optionaler Override; meist weglassen — Dimensionen werden aus einer Built-in-Map nachgeschlagen.                                         |
| `embeddingQueryPrefix`     | Präfix für Query-Task-Embeddings. Ungesetzt → Modell-Preset oder Nomic, wenn `embeddingUseTaskPrefixes` true ist. Explizites `""` deaktiviert. |
| `embeddingDocumentPrefix`  | Präfix für Document-Task-Embeddings (gleiche Auflösungsregeln wie `embeddingQueryPrefix`).                                               |
| `embeddingUseTaskPrefixes` | Opt-in für Nomic-Präfixe `search_query:` / `search_document:`, wenn Custom-/Preset-Präfixe nicht gesetzt sind. Standard `false`.          |

Beispiel — OpenAI:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Beispiel — ein selbst gehosteter Endpoint:

```jsonc
{
  "embeddingApiUrl": "http://127.0.0.1:8765/v1",
  "embeddingApiKey": "local-dev-key",
  "embeddingModel": "nomic-embed-text-v1.5",
}
```

Änderungen an `embeddingModel`, Dimensionen oder Task-Präfixen können erfordern, gespeicherte Memories neu zu embedden, damit Store- und Query-Vektoren ausgerichtet bleiben. Besser einmal ein Modell (und Präfix-Einstellungen) wählen und für eine gegebene sqld-Datenbank dabei bleiben.

### Speicher-Scope

- `scope: "project"`: nur das aktuelle Projekt abfragen. Das ist der Standard.
- `scope: "all-projects"`: `search` / `list` über alle Projekt-Shards abfragen.
- `memory.defaultScope` setzt den Standard-Query-Scope, wenn kein expliziter Scope angegeben ist.

### Web-UI HTTP Basic Auth

Wenn `webServerHost` auf etwas anderes als Loopback gesetzt ist (z. B. `0.0.0.0`), ist die Web-UI für jeden im Netzwerk erreichbar. Damit deine Memories nicht im LAN liegen, den Webserver über HTTP Basic Auth in derselben Config-Datei wie alles andere absichern:

```jsonc
{
  "webServerHost": "0.0.0.0", // optional: UI aus dem LAN erreichen
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optional, Standard ist der aktuelle OS-User
}
```

| Feld                    | Standard          | Wirkung                                                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `webServerAuthPassword` | _(leer)_          | Wenn gesetzt, verlangt der Server bei jedem Request HTTP-Basic-Auth-Credentials. Leer lassen für das standardmäßig offene Verhalten. |
| `webServerAuthUsername` | OS-User (`$USER`) | Vom Basic-Auth-Challenge geforderter Username.                                                                                       |

`webServerAuthPassword` akzeptiert dieselben Secret-Formate wie `memoryApiKey`:

- ein Literal-String (einfach, für persönliche Maschinen in Ordnung),
- `env://SOME_ENV_VAR`, um den Wert beim Start aus der Umgebung zu lesen,
- `file:///path/to/secret`, um ihn aus einer Datei zu lesen (`chmod 600` empfohlen — das Plugin warnt, wenn die Datei world-readable ist).

Der Browser zeigt seinen nativen Basic-Auth-Dialog und merkt sich die Credentials für die aktuelle Sitzung; alle Browserfenster zu schließen verwirft sie, sodass beim erneuten Öffnen des Browsers wieder angemeldet werden muss. Credentials werden mit einem Constant-Time-Check verglichen, und die nicht authentifizierte 401-Antwort trägt `Cache-Control: no-store`, damit kein Zwischen-Cache sie wiedergibt. CORS wird auch gelockert, sobald Auth an ist, sodass andere Tools im selben LAN nach Authentifizierung mit der API sprechen können.

### Gemeinsamen Projektspeicher über verschachtelte Repos teilen

Standardmäßig wird ein Projekt über sein umschließendes Git-Repository identifiziert, sodass jedes
physische Git-Repo einen eigenen isolierten Speicher erhält. Das ist falsch für
Multi-Repo-Workspaces — Bäume, die von Googles [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md)
verwaltet werden, Monorepos oder jedes Layout, in dem mehrere verschachtelte Git-Repositories zu einem
logischen Projekt gehören —, weil jedes Sub-Repository siloed wäre.

Lege eine leere Marker-Datei **`.opencode-mem-project`** an der Workspace-Wurzel ab:

```
my-workspace/
├── .opencode-mem-project   ← Workspace-Wurzel
├── kernel/                 (eigenes Git-Repo)
├── userspace/              (eigenes Git-Repo)
└── tools/                  (eigenes Git-Repo)
```

Jede Sitzung, die irgendwo unterhalb des Markers gestartet wird, löst dann auf diese
Wurzel auf und teilt einen Speicher, unabhängig davon, in welchem Sub-Repo das Arbeitsverzeichnis liegt:

```sh
touch ~/my-workspace/.opencode-mem-project
```

Der Marker wird durch Aufwärtslaufen vom Arbeitsverzeichnis gefunden, das jeder
Codepfad bereits übergibt (Arbeitsverzeichnis des Plugins, `process.cwd()` der Web-API),
sodass die Identität **verzeichnisgetrieben und prozessunabhängig** ist.
Sie stützt sich nicht auf Umgebungsvariablen oder einen globalen Config-Wert, die
hier unzuverlässig wären: opencode-mem läuft über mehrere opencode-Prozesse,
die einen einzelnen Webserver teilen, und nur einige dieser Prozesse tragen eine
gegebene Env-Var. Mit dem Marker wird die Projektwurzel immer davon abgeleitet, wo
die Sitzung tatsächlich läuft.

Der Marker hat Vorrang vor der Git-Erkennung. Ist er vorhanden, wird die
eigene Git-Remote des Sub-Repos absichtlich ignoriert (sie würde nur ein
verschachteltes Repository beschreiben). Ohne Marker bleibt das Verhalten unverändert (Git-basierte
Identität).

### Projektspeicher verschieben oder wiederherstellen

opencode-mem schlüsselt Projekt-Shards über einen Hash der Projektidentität. Das Verschieben eines
Repositories (OS-Migration, Pfad-Reorganisation, Wechsel von einem Windows-Mount
auf einen nativen Pfad) kann daher den alten Shard unter
`~/.opencode-mem/data/projects/` verwaisen lassen, während für den
neuen Pfad ein neuer leerer Shard angelegt wird.

Das sind OpenCode-`memory`-Tool-Aufrufe mit JSON-Argumenten, keine Befehle zum
Ausführen im Terminal. Die Issue-ähnliche Notation `memory migrate --from ...` entspricht
`memory({ mode: "migrate", fromPath: "..." })`.

**1. Lokaler Umzug, wenn du den alten Pfad noch kennst**

OpenCode im **neuen** Projektverzeichnis öffnen. Das Zielprojekt darf noch
keine Memories enthalten (Migration bricht bei Konflikt unverändert ab). Vor jeder Änderung die
erkannte Quelle, das Ziel und die Dateiaktionen prüfen:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Zur Sicherheit lehnt die Migration eine Quelle ab, deren gespeichertes Projektverzeichnis noch
existiert. Wenn du eine aktive Quelle absichtlich verschieben willst, zuerst die Dry-Run-
Ausgabe prüfen und dann `allowLinkedSource: true` übergeben. Original-Quell-Shard-
Dateien bleiben als zeitgestempelte `*.pre-path-migrate-*.bak`-Backups erhalten.

**2. Alter Pfad ist weg — zuerst den verwaisten Shard finden**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` meldet jeden Projekt-Hash, den gespeicherten `projectPath`, die Memory-Anzahl
und den Status (`current`, `linked`, `orphaned`, `missing-file`, `empty` oder
`ambiguous`). `fromHash` ist der 16-stellige hexadezimale Kleinbuchstaben-`scopeHash`,
den dieser Aufruf zurückgibt. Bevorzuge ihn, wenn das alte Verzeichnis nicht mehr existiert oder
mehrere Shards denselben gespeicherten Pfad enthalten, weil Git-basierte Identitäten
aus einem fehlenden Pfad nicht immer neu berechnet werden können.

**3. Maschinenübergreifendes Backup / Restore**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export schreibt ein versioniertes JSON-Dokument ohne Vektoren. Import mappt die
Memories auf das aktuelle Projekt um und berechnet Embeddings mit dem aktuell
konfigurierten Modell neu. Import fügt Memories zu einem bestehenden Projekt hinzu, aber doppelte
Memory-IDs brechen den gesamten Import vor dem Schreiben ab; das unterscheidet sich von `migrate`,
das ein leeres Ziel verlangt.

Export-Dateien sind Klartext und können Memory-Inhalte, User-Namen/E-Mail-
Adressen, Repository-URLs und absolute Projektpfade enthalten. Sie wie andere
sensible Backups speichern und löschen, wenn sie nicht mehr benötigt werden. Vollständig private Einträge
werden ausgelassen, und Benutzerprofile sowie Prompt-Historie sind nicht enthalten. Das
Dokument enthält `schemaVersion: 1`; Imports lehnen neuere nicht unterstützte Schema-
Versionen ab, statt zu raten.

### Auto-Capture-KI-Provider

Auto-Capture führt eine Hintergrund-KI-Anfrage aus, um technische Arbeit zusammenzufassen und als Memory zu speichern. Es braucht eine der Provider-Konfigurationen unten.

**Empfohlen:** Einen Provider nutzen, der in opencode bereits authentifiziert ist und strukturierte Ausgabe unterstützt:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

Das Plugin stellt strukturierte Output-Requests an die Session-API von opencode, statt Provider-Endpoints direkt aufzurufen, sodass opencode Auth, Token-Refresh und Provider-Routing besitzt. Der Provider-Name muss einem Eintrag aus `opencode providers list` entsprechen, und das gewählte Modell muss strukturierte JSON-Ausgabe über opencode unterstützen.

Optional eine Reasoning-Variante des Modells mit `"opencodeVariant": "xhigh"` pinnen (z. B. für grok-4.7). Sie gilt für die internen LLM-Aufrufe des Plugins (Auto-Capture-Zusammenfassungen, Profil-Lernen, Profil-Cleanup), auch wenn `opencodeModel` `"inherit"` ist, sodass Hintergrundarbeit ein anderes Reasoning-Level als die interaktive Sitzung nutzen kann.

Langsame Reasoning-Modelle (oder sehr große Profil-Prompts) können das Standard-Budget von 90 s für strukturierte Ausgabe überschreiten. `"opencodeTimeoutMs"` (Millisekunden) setzen, um es für interne Structured-Output-Aufrufe (Auto-Capture-Zusammenfassungen, Profil-Lernen) zu verlängern — z. B. `"opencodeTimeoutMs": 180000` für 3 Minuten. Werte werden auf 10000..600000 geklemmt; der Standard bleibt 90000. Numerische Strings werden coerced. Profil-Cleanup nutzt ein separates, längeres Timeout.

Unterstützte Provider: jeder von `opencode providers list` gelistete Provider (z. B. `anthropic`, `openai`, `github-copilot`, `openrouter`, ...).

**Eingebaute Free-/Zen-Modelle** unter der Provider-ID `opencode` (z. B. `big-pickle`) können die internen Structured-Output-Sitzungen des Plugins oft nicht ausführen — OpenCode lehnt sie außerhalb des interaktiven Chats möglicherweise ab. Besser einen authentifizierten Provider aus `opencode providers list` verwenden oder `"opencodeModel": "inherit"` nutzen, damit Capture dem Modell folgt, das du in der Sitzung bereits verwendest.

Ist `autoCaptureEnabled` `true` (Standard), aber weder `opencodeProvider`/`opencodeModel` noch ein vollständiger manueller Fallback konfiguriert, loggt das Plugin eine Warnung und zeigt beim Start einen Toast (wenn `showErrorToasts` aktiviert ist), sodass fehlende Konfiguration sichtbar ist, ohne Logs durchsuchen zu müssen.

Wenn `opencodeProvider` und `opencodeModel` gesetzt sind, haben sie standardmäßig Vorrang vor den manuellen `memoryProvider`-Einstellungen unten (`"autoCaptureProviderOrder": "opencode-first"`). `"autoCaptureProviderOrder": "external-first"` setzen, um die manuelle API zu bevorzugen, wenn beide konfiguriert sind (nützlich, wenn die Session-API des Hosts ausgelastet/langsam ist); der andere Kanal dient als Fallback. `"opencodeTimeoutMs"` senken, um früher vom opencode-Kanal auf den Fallback umzuschalten.

**Sitzungsmodell folgen:** `"opencodeModel": "inherit"` setzen, um zur Aufrufzeit ein konkretes OpenCode-Modell statt einer gepinnten ID zu nutzen. Für **Auto-Capture** wird jeder Prompt über den `chat.params`-Hook aufgezeichnet und der Capture-Request wiederverwendet Provider/Modell dieses Prompts. Für **Profil-Lernen** und andere Structured-Output-Pfade (die nicht an eine einzelne User-Nachricht gebunden sind) nutzt `inherit` zuerst das zuletzt vom Host über `chat.params` / den V2-Context-Hook gemeldete Modell und fällt danach auf die Recent-Liste in OpenCodes `model.json` zurück, falls vorhanden (bevorzugt den konfigurierten `opencodeProvider`). OpenCode v2 schreibt `model.json` nicht mehr; dort ist das In-Process-Sitzungsmodell der primäre Fallback. Das wörtliche Modell-ID `inherit` zu senden ist nie gültig und verursachte zuvor `ProviderModelNotFoundError: Model not found: <provider>/inherit` auf diesen Pfaden. `opencodeProvider` bleibt als normale Config-Gate erforderlich.

**Fallback:** Manuelle API-Konfiguration (wenn opencodeProvider nicht genutzt wird):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API-Key-Formate:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Manuelle `memoryProvider`-Modi:

- `openai-chat`: OpenAI-Chat-Completions-kompatible API mit Tool-/Function-Calling. Kann mit kompatiblen Proxies wie LiteLLM nur funktionieren, wenn das gewählte Upstream-Modell und der Proxy Tool-Calls erhalten.
- `openai-responses`: OpenAI Responses API mit Function-Call-Ausgabe.
- `anthropic`: Anthropic Messages API mit Tool Use.
- `minimax`: MiniMax Anthropic-Messages-kompatibler Endpoint. `memoryApiUrl` auf den globalen Endpoint (`https://api.minimax.io`) oder den [China-Endpoint](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api.md) (`https://api.minimax.cn`) setzen; der Pfad `/anthropic/v1/messages` und der Header `x-api-key` werden automatisch angewendet. `MiniMax-M3.1-Flash` (empfohlen) oder `MiniMax-M3` verwenden, beide mit 1.000.000-Token-Kontext. Flash denkt immer; optional `memoryExtraParams` auf `{ "output_config": { "effort": "max" } }` setzen mit `low`, `medium`, `high`, `xhigh` oder `max` (Standard). Flash lehnt deaktiviertes Thinking und Effort `none` ab und unterstützt kein `service_tier`. M3-Thinking ist auf diesem Endpoint standardmäßig aus; aktivieren mit `{ "thinking": { "type": "adaptive" } }`. Modell-IDs bleiben explizit konfiguriert; vorhandene Custom- oder Legacy-IDs werden unverändert durchgereicht. Siehe die [MiniMax-Kompatibilitätsreferenz](https://platform.minimax.io/docs/api-reference/text-anthropic-api.md).
- `orcarouter`: OpenAI-kompatibles Model-Gateway mit namenspaced Model-IDs. `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.orcarouter.ai/v1` und `orcarouter/auto` (ein Routing-Alias, der pro Request ein fähiges Modell wählt). Wenn du `memoryModel` setzt, eine namenspaced ID wie `openai/gpt-5.5` oder `deepseek/deepseek-v4-flash` verwenden; OrcaRouter lehnt bare Modellnamen ab. Beispiel:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) betreibt auf demselben Endpoint auch Gateway-Level-Zero-Trust-Security für KI-Agenten — prüft jeden Prompt/jede Response und steuert jeden Tool-Call auf Default-Deny-Basis, ohne Änderungen am Anwendungscode.
- `atlas-cloud`: OpenAI-kompatibles Chat-Completions-Preset für [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.atlascloud.ai/v1` und `deepseek-ai/deepseek-v4-pro`. Fehlt `memoryApiKey`, wird `ATLASCLOUD_API_KEY` aus der Umgebung verwendet. Beispiel:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://api.atlascloud.ai` übertragen.
- `cheaper-inference`: OpenAI-kompatibles Chat-Completions-Preset für [Cheaper Inference](https://cheaperinference.com). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.cheaperinference.com/v1` und `gpt-5.4-mini`. Fehlt `memoryApiKey`, wird `CHEAPER_INFERENCE_API_KEY` aus der Umgebung verwendet. Beispiel:
  ```jsonc
  "memoryProvider": "cheaper-inference",
  "memoryApiKey": "env://CHEAPER_INFERENCE_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://api.cheaperinference.com` übertragen.
- `api-route`: OpenAI-kompatibles Chat-Completions-Preset für [API Route](https://www.api-route.com/en/docs/quickstart). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://global.api-route.com/v1` und `gpt-6.1-sol`. Fehlt `memoryApiKey`, wird `API_ROUTE_API_KEY` aus der Umgebung verwendet. Beispiel:
  ```jsonc
  "memoryProvider": "api-route",
  "memoryApiKey": "env://API_ROUTE_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://global.api-route.com` übertragen.
- `runcrate`: OpenAI-kompatibles Chat-Completions-Preset für [Runcrate](https://www.runcrate.ai). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.runcrate.ai/v1` und `deepseek-ai/DeepSeek-V4.1-Flash`. Fehlt `memoryApiKey`, wird `RUNCRATE_API_KEY` aus der Umgebung verwendet. Beispiel:
  ```jsonc
  "memoryProvider": "runcrate",
  "memoryApiKey": "env://RUNCRATE_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://api.runcrate.ai` übertragen.
- `cloudgpu`: OpenAI-kompatibles Chat-Completions-Preset für [CloudGPU](https://cloudgpu.app). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://cloudgpu.app/v1` und `deepseek-v4.1-flash`. Fehlt `memoryApiKey`, wird `CLOUDGPU_API_KEY` aus der Umgebung verwendet (Key erstellen unter https://cloudgpu.app/api/console; API-Doku: https://cloudgpu.app/api/docs). Beispiel:
  ```jsonc
  "memoryProvider": "cloudgpu",
  "memoryApiKey": "env://CLOUDGPU_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://cloudgpu.app` übertragen.
- `standardcompute`: OpenAI-kompatibles Chat-Completions-Preset für [Standard Compute](https://standardcompute.com). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.stdcmpt.com/v1` und `StandardCompute`. Fehlt `memoryApiKey`, wird `STANDARDCOMPUTE_API_KEY` aus der Umgebung verwendet (Key erstellen unter https://standardcompute.com/dashboard; API-Doku: https://docs.standardcompute.com). Beispiel:
  ```jsonc
  "memoryProvider": "standardcompute",
  "memoryApiKey": "env://STANDARDCOMPUTE_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://api.stdcmpt.com` übertragen.

Fehlerbehebung:

- Auto-Capture-Fehler blockieren die manuelle Nutzung des `memory`-Tools nicht.
- Auto-Capture bewahrt begrenzten finalen Assistant-Text und terminale Tool-Ergebnisse aus
  zugestellten V1/V2-Events, bevor die verzögerte Zusammenfassung läuft. Normales Idle-Capture
  bevorzugt weiterhin das Live-Transkript des Hosts; bereite ausstehende Evidenz ist der Fallback,
  wenn die Sitzung bereits weg ist (Löschung oder Startup-Replay). Die Wiederherstellung ist auf
  dasselbe Projekt beschränkt und nutzt den normalen Capture-Provider und die Claim-Queue. Sie
  leitet abgeschlossene Arbeit nicht allein aus der Anfrage ab. Das Löschen einer OpenCode-Sitzung
  löscht diese ausstehende Memory-Evidenz oder bereits erfasste Memories **nicht**.
- Ausstehende Evidenz wird vor der Persistierung um Private-Tags bereinigt (einschließlich Tags,
  die finale Textteile innerhalb einer Assistant-Nachricht überspannen); Reasoning, Anhänge, rohe
  Provider-Metadaten, Streaming-Deltas und Tool-Argumente sind ausgeschlossen. Limits sind 16 KiB
  pro Part, 16 Parts pro Prompt, 256 Parts global (höchstens 4 MiB Text) und 64 KiB pro Capture.
  Kürzungen werden markiert; die ältesten Parts werden verdrängt, wenn das Budget überschritten
  wird. Evidenz läuft nach 24 Stunden ab und wird beim nächsten Store-Zugriff bereinigt. Sie wird
  gelöscht, wenn Capture abschließt/überspringt oder ihr Prompt über bestehende Lösch-/Retention-Pfade
  entfernt wird. Dies sind logische Aufbewahrungslimits, keine sichere Löschung von SQLite-/WAL-Backups.
- V2-Events sind ein flüchtiger Stream: getrennte/verpasste Events, nicht auflösbare Prompt-Zuordnung
  und durch Ablauf/Verdrängung verlorene Evidenz können nicht wiederhergestellt werden. Garantiert
  ist Capture aus Evidenz, die empfangen, gespeichert und durch ein Idle-/Deleted-Event als bereit
  gecheckpointet wurde, nicht die Rekonstruktion ungesehener oder zuvor gelöschter Transkripte. Nach
  diesem Checkpoint ist die Sitzung gegen späte Rebinds versiegelt, bis zur nächsten verfassten
  User-Eingabe (V2 `session.inbox.delivered`, V1 User-`message.updated`), sodass gepufferte Parts
  bereite Evidenz nicht wieder auf nicht bereit zurücksetzen können. Ein Disconnect vor dem terminalen
  Checkpoint lässt die partielle Evidenz bis zu einem späteren Checkpoint zurückgestellt; ein Neustart
  nimmt nicht an, dass unfertige Arbeit abgeschlossen ist. V1 nutzt explizite Assistant-Parent-IDs;
  V2 friert die zugestellte Eingabe beim Step-Start ein, statt den zuletzt eingereihten Prompt zu raten.
- Meldet der Live-Host `Session.NotFoundError` (oder hat Löschung/Startup-Replay keine bereite
  Evidenz), loggt Capture `skipped` / `session_not_found`, gibt seinen Claim ohne Backoff und ohne
  Verbrauch von Retries frei und überspringt weitere hostabhängige Lookups in diesem Batch. Spätere
  Prompts mit bereiter gespeicherter Evidenz laufen weiterhin. Ein späteres unabhängiges Idle kann
  es erneut versuchen. Bereits erschöpfte Prompts werden nicht wiederbelebt. Andere Fehler behalten
  ihr bestehendes Retry-Verhalten.
- Auto-Capture-Ergänzungen nutzen eine stabile ID pro Projekt/Prompt, sodass sequenzielles
  Crash-/Restart-Replay das vorherige Memory wiederverwendet, einschließlich soft-gelöschter
  Einträge, statt es einzufügen oder wiederzubeleben. Dies beansprucht keine verteilte
  Exactly-Once-Semantik für optionale semantische Update-/Supersede-Operationen oder jede
  Multi-Prozess-Crash-Verschränkung.
- Meldet Auto-Capture, dass ein Provider nicht verbunden ist, den Provider-Namen mit `opencode providers list` bestätigen und diesen Provider zuerst in opencode konfigurieren.
- Gibt ein Proxy oder Custom-Provider Klartext statt strukturierter/Tool-Ausgabe zurück, ein anderes Modell/einen anderen Provider wählen oder einen der manuellen Provider-Modi oben nutzen.
- Für Modelle, die `temperature` ablehnen, bei manueller API-Konfiguration `"memoryTemperature": false` hinzufügen.
- Für Modelle, die erzwungene Tool-Calls ablehnen (`tool_choice: "required"`, z. B. manche Thinking-Modi), bei `openai-chat` / `orcarouter` / `atlas-cloud` / `cheaper-inference` / `api-route` / `runcrate` / `cloudgpu` / `standardcompute` `"forceToolChoice": false` hinzufügen.
- Bei `opencodeProvider` / `opencodeModel` (z. B. DeepSeek V4 Thinking) sendet OpenCode weiterhin erzwungenes `tool_choice` für strukturierte Ausgabe. opencode-mem deaktiviert Thinking auf dem internen Agenten `opencode-mem-structured` (und wendet das in `chat.params` nach Variant-Merge erneut an), damit Auto-Capture und Profil-Lernen abschließen können. Dein interaktiver Chat-Agent bleibt unverändert. Scheitert Capture weiterhin mit einem Thinking-/`tool_choice`-Fehler, für `opencodeModel` ein Non-Thinking-Modell wählen oder einen vollständigen manuellen Fallback konfigurieren (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** Auto-Capture nutzt OpenCode mit deinem authentifizierten `anthropic`-Provider. Erzwungenes `format: json_schema` loopt oft mit Claude-Auth, daher nutzt opencode-mem einen Auth-erhaltenden **Text-JSON**-Pfad für `opencodeProvider: "anthropic"` (keine erzwungenen `StructuredOutput`-Tools; Antwort wird mit Zod geparst). Ein Step-Watchdog bricht runaway interne Sitzungen nach 2 Schritten weiterhin ab. Scheitert Capture weiterhin, einen vollständigen manuellen Anthropic-API-Key-Fallback konfigurieren (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth lässt sich außerhalb von OpenCode nicht wiederverwenden.
- **Datenbankverbindungsfehler:** prüfe, dass sqld läuft und `sqldUrl` darauf zeigt (standardmäßig `http://127.0.0.1:8080`), und setze `sqldAuthToken`, wenn der Server Authentifizierung verlangt.
- **Lokaler sqld startete nicht:** `autoStartSqld` benötigt laufendes Docker; starte Docker oder nutze `docker compose -f scripts/sqld-compose.yml up -d`. Der erste Pull kann Minuten dauern — bei einem Timeout prüfe `docker logs opencode-mem-sqld` und versuche es erneut.
- **Fehler „Remote embeddings are required“:** setze sowohl `embeddingApiUrl` als auch `embeddingApiKey`; es gibt kein lokales Embedding-Backend.

## Öffentliche Subpath-Exports

Zusätzlich zum Haupt-Plugin-Entrypoint exponiert `opencode-mem` einen stabilen Subpath,
den andere opencode-Plugins direkt importieren können. Das vermeidet, Container-Tag-
Konventionen reverse-engineeren zu müssen, wenn Drittanbieter-Tools geschrieben werden, die
in denselben Speicher lesen oder schreiben.

### `opencode-mem/tags`

Kanonische Container-Tag-Helfer. Dieselben Funktionen, die opencode-mem selbst nutzt,
um auto-erfasste Memories zu scopen.

```ts
import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

// Canonical project tag derived from cwd (git remote URL if present, else
// the project root path). Format: `opencode_project_<sha16>`.
const projectTag = getProjectTagInfo(process.cwd()).tag;

// Canonical user tag derived from `git config user.email`.
// Format: `opencode_user_<sha16>`.
const userTag = getUserTagInfo().tag;

// Both at once.
const { user, project } = getTags(process.cwd());
```

Von diesen Helfern erzeugte Tags entsprechen dem, was Auto-Capture schreibt, sodass Drittanbieter-
Plugins, die `POST /api/memories` aufrufen, in denselben Shards landen, die der Rest
des Systems bereits versteht. Handgemachte Tags, deren Substring nicht
`_project_` oder `_user_` ist, landen in Shadow-Shards, die `/api/stats` und
`/api/memories` stillschweigend herausfiltern — diese Helfer vermeiden diese Falle.

## Entwicklung & Beitrag

Lokal bauen und testen:

```bash
bun install
bun run build
bun test
bun run quality
```

`bun run quality` führt `format:check`, `lint` und `typecheck` aus; `bun run format` schreibt die Formatierung neu.

Die [Dokumentation](https://opencode-mem.zhafron.my.id/docs/) wird aus dieser README und den Übersetzungen unter `.github/i18n/` generiert; die [Landingpage](https://opencode-mem.zhafron.my.id) liegt in `github-site/src/`. Jede README-Überschrift muss in `github-site/docs-map.json` einer Docs-Seite zugeordnet sein, sonst schlägt der Site-Build fehl. Baue die Site lokal mit `cd github-site && bun install && bun run build`.

Dieses Projekt sucht aktiv Beiträge, um das maßgebliche Memory-Plugin für KI-Coding-Agenten zu werden. Ob du Bugs behebst, Features hinzufügst, Dokumentation verbesserst oder die Embedding-Modell-Unterstützung erweiterst — deine Beiträge sind entscheidend. Die Codebasis ist gut strukturiert und bereit für Erweiterungen. Bitte Issues mit den Vorlagen Issue oder Feature request öffnen und beim Einreichen eines PRs die Pull-Request-Vorlage ausfüllen — wir reviewen und mergen Beiträge zügig.

**README-Übersetzungen:** `README.md` (Englisch) ist die Quelle der Wahrheit. Wenn du dessen Inhalt änderst, aktualisiere die Dateien unter `.github/i18n/` (`README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md` und `README.nl.md`) entsprechend.

## Lizenz & Links

MIT License - siehe LICENSE-Datei

- **Website**: https://opencode-mem.zhafron.my.id
- **Dokumentation**: https://opencode-mem.zhafron.my.id/docs/
- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **npm**: https://www.npmjs.com/package/opencode-mem
- **OpenCode Platform**: https://opencode.ai

Inspiriert von [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
