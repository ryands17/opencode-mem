# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)
[![Website](https://img.shields.io/badge/website-opencode--mem.zhafron.my.id-blue)](https://opencode-mem.zhafron.my.id)
[![Docs](https://img.shields.io/badge/docs-opencode--mem.zhafron.my.id%2Fdocs-blue)](https://opencode-mem.zhafron.my.id/docs/)

![OpenCode Memory Banner](../pics/banner.png)

Talen: [🇬🇧](../../README.md) | [🇩🇪](./README.de.md) | [🇨🇳](./README.zh.md) | [🇸🇦](./README.ar.md) | [🇹🇷](./README.tr.md) | **🇳🇱**

Een persistent geheugensysteem voor AI-codingagents dat langetermijncontextbehoud over sessies mogelijk maakt met vectorzoekopdrachten ondersteund door een libSQL-server (sqld).

## Kernfuncties

- **Database:** een libSQL-server (`sqld`) bevat de herinneringen met native vectorzoekopdrachten; geen aparte vectordatabase en geen native bindings.
- **Intelligente promptgebaseerde geheugenextractie (auto-capture):** wanneer een sessie inactief wordt, zet een AI-verzoek op de achtergrond het technische werk om in persistente projectherinneringen.
- **Automatisch ophalen:** relevante herinneringen en het gebruikersprofiel worden in de context van het model geïnjecteerd (`chatMessage`).
- **Automatisch leren van gebruikersprofielen:** een projectoverstijgende samenvatting van je voorkeuren, patronen en workflows.
- **Geheugenhygiëne:** slimme deduplicatie, optionele update-on-capture en optionele dreaming-consolidatie met herstelbare prullenbak.
- **Multi-provider AI-ondersteuning:** elke provider die in OpenCode is geconfigureerd (`opencodeProvider` / `opencodeModel`), of een handmatige API: OpenAI Chat Completions, OpenAI Responses, Anthropic, MiniMax, OrcaRouter, Atlas Cloud, Cheaper Inference, API Route, Runcrate, CloudGPU.
- **Embeddings:** elke OpenAI-compatibele embeddings-API (vereist); geen lokale modeldownload en geen GPU nodig.
- **Volledige web-UI:** uniforme memory–prompt timeline, gebruikersprofiel, skillbibliotheek, Markdown vault en gezondheidsstatistieken, met optionele HTTP Basic Auth.
- **Ingebouwde privacybescherming:** `<private>`-tags en het verwijderen van inloggegevens vóór het vastleggen.
- **Overdraagbaarheid:** optionele Markdown vault-backend, en `export` / `import` / `migrate` van de `memory`-tool voor verplaatste of gekopieerde projecten.

## Vereisten

opencode-mem slaat herinneringen op in een **libSQL-server (`sqld`)** die via HTTP/WebSocket bereikbaar is met de pure-JS-transport `@libsql/client/web`. Het gebruikt `F32_BLOB`-vectoren en exacte cosinuszoekopdrachten via `vector_distance_cos`. Er zijn **geen native bindings of lokale ML-runtime**, dus de plugin draait overal waar Bun draait — inclusief Intel Macs (`darwin/x64`). Je hebt een draaiende sqld-server nodig (zie [Aan de slag](#aan-de-slag)) en een remote embedding-endpoint.

**Aanbevolen runtime:**

- Bun
- Standaard OpenCode-pluginomgeving
- Docker (of een andere manier om een `sqld`-server te draaien) voor de geheugendatabase
- Een remote OpenAI-compatibele embeddings-API en -sleutel (`embeddingApiUrl` + `embeddingApiKey`)
- Voor bron-/ontwikkelingsinstallaties: voer `bun install` uit vóór het bouwen of testen. Het gepubliceerde pluginpakket installeert zijn runtime-afhankelijkheden automatisch via OpenCode.

**CI-geteste platforms:** Linux, Windows, macOS op Apple Silicon (`darwin/arm64`) en Intel (`darwin/x64`). sqld en remote embeddings hebben geen platformspecifieke native bindings.

**Opmerkingen:**

- Vector-embeddings worden direct in sqld opgeslagen en doorzocht; inserts slaan `F32_BLOB`-vectoren op voor exacte cosinusranking.
- Vectorzoekopdrachten gebruiken exacte cosinusafstand via `vector_distance_cos` (geen DiskANN / approximatieve index), met optionele keyword-hybrid ranking wanneer een querystring wordt meegegeven.
- Sessieopzoekingen gebruiken een geïndexeerde `session_id`-kolom (teruggevuld vanuit `metadata.sessionID` op schema v2).
- Auto-capture en gebruikersprofiel-leren vereisen een AI-provider die structured/tool-call-output kan teruggeven. Memory search/add/list werken nog steeds zonder auto-capture-providerconfiguratie.
- Alle herinneringen voor een installatie leven in één sqld-database, logisch gepartitioneerd per container-tag (project/gebruiker). `storagePath` bevat alleen lokale caches en Markdown vault-indexen.

### Hardware- / resourceverwachtingen

opencode-mem vereist **geen** GPU of lokale ML-runtime — embeddings komen van je geconfigureerde remote API, er worden geen modellen gedownload of in het geheugen gehouden.

| Workload                                               | Typische extra resources                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Embeddings** (`embeddingApiUrl` + `embeddingApiKey`) | Verwaarloosbare lokale RAM — alleen de plugin; het embeddingwerk vindt plaats bij de API.                                        |
| **Database / plugin**                                  | Herinneringen leven in de sqld-server. Lokaal schijfgebruik onder `storagePath` beperkt zich tot caches en Markdown vault-indexen. |

Zie [Embeddings kiezen / configureren](#embeddings-kiezen--configureren).

### Upgraden vanaf legacy SQLite-shards

Eerdere releases bewaarden elke memory-shard in een ingebed Turso-databasebestand onder `storagePath`. Die engine (en de `multiprocess_wal`, WAL-indexherstel, DiskANN-conversie en bestandsgebaseerde migratiemarkers) wordt niet langer gebruikt: herinneringen leven nu in één sqld-server en zijn gepartitioneerd per container-tag. Een nieuwere plugin starten tegen een oude installatie converteert die oude bestanden niet — start sqld, richt `sqldUrl` erop en importeer je herinneringen met de `export` / `import`-commands van de `memory`-tool als je ze wilt meenemen.

Als opgeslagen vectoren incompatibel worden met de geconfigureerde embeddings (bijvoorbeeld na wijziging van `embeddingDimensions`), worden writes naar die logische shard geblokkeerd. Gebruik de re-embed-migratie in de web-UI om een vervanging te bouwen en te verifiëren; de vorige shard wordt in sqld gearchiveerd vóór de omwisseling. `sqldUrl` naar een andere server of database richten geeft je ook een schone store zonder de oude aan te raken.

## Schemamigraties

Geheugentabellen in sqld worden geüpgraded met geordende, per-label versiemigraties die worden bijgehouden in de tabel `_opencode_mem_schema_versions` (geïmplementeerd in `src/services/turso/schema-migrations.ts`). Hulgegevens (skills, gebruikersprompts, gebruikersprofielen, AI-sessies) gebruiken hetzelfde mechanisme met een eigen label. Migraties zijn idempotent: bij starten van de plugin worden alleen openstaande versies toegepast.

## Aan de slag

### sqld instellen

Herinneringen leven in een [libSQL-server (`sqld`)](https://github.com/tursodatabase/libsql). De snelste manier om er een te draaien is Docker met een named volume, zodat de data containerherstarts overleeft:

```bash
docker run -d --name opencode-mem-sqld \
  -p 8080:8080 \
  -v opencode-mem-sqld-data:/var/lib/sqld \
  -e SQLD_NODE=primary \
  ghcr.io/tursodatabase/libsql-server:latest
```

Als alternatief gebruik je [`scripts/sqld-compose.yml`](scripts/sqld-compose.yml): `docker compose -f scripts/sqld-compose.yml up -d`.

Bevestig dat de server gezond is op `http://127.0.0.1:8080/health`. De plugin default naar `sqldUrl: "http://127.0.0.1:8080"`, dus deze lokale setup heeft geen configwijziging nodig. Voor een externe server stel je `sqldUrl` in en, als die authenticatie vereist, `sqldAuthToken` (accepteert `env://…` en `file://…`-referenties).

Houd het named volume bij het upgraden of opnieuw aanmaken van de container — verwijderen wist alle herinneringen. Maak er een back-up van (of voer `memory export` uit) vóór elke destructieve operatie. Je hebt ook een remote embedding-endpoint nodig; zie [Embeddings kiezen / configureren](#embeddings-kiezen--configureren).

Voor OpenCode v2 voeg je het pakket toe aan de native `plugins`-lijst:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode laadt ook automatisch de `./tui`-companion van het pakket zodat
auto-capture- / profiel- / fouttoasts in de TUI verschijnen (serverplugins
kunnen `ui.toast` niet rechtstreeks aanroepen). Je hebt geen tweede entry in
`plugins` nodig. Als je een CLI-only TUI tegen een remote OpenCode-server
draait, registreer `opencode-mem/tui` in de pluginlijst van die CLI (bijvoorbeeld
`cli.json`) zodat de companion kan inschrijven op toast-RPC-events.

Voor OpenCode v1 voeg je de standaard entrypoint toe aan je configuratie op
`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

Met `@latest` (of een semver-bereik) en `autoUpdate: true` in `opencode-mem.jsonc` (standaard) wist de plugin de gecachte OpenCode-installatie wanneer een nieuwere npm-release beschikbaar is en vraagt je om te herstarten. Vastgezette versies zoals `opencode-mem@2.26.0` worden nooit automatisch bijgewerkt.

### Automatische geheugencontext op OpenCode v2

De v2-plugin levert automatische geheugencontext via de systeemcontext van het model.
Deze blokken worden niet toegevoegd aan de geschreven gebruikersprompt en niet opgeslagen in het chattranscript.
Met `chatMessage.injectOn: "first"` (de standaard) blijft de initiële context van de sessie
behouden over gebruikersbeurten en modelstappen. Met `"always"` wordt deze bij elke
geschreven gebruikersbeurt vernieuwd.

Na een host- of pluginherstart bouwt een hervatte sessie bij het volgende modelverzoek
zijn context opnieuw op vanuit de huidige memory store, ook als er geen nieuwe gebruikersprompt binnenkomt.
De herbouwde context kan afwijken van de oorspronkelijke naarmate herinneringen en het profiel evolueren.
Herstel legt geen synthetische gebruikersprompt vast en slaat geen tweede kopie van de
geheugentekst op in OpenCode-pluginopslag. Compaction invalideert de gecachte automatische
context; de bestaande compaction-memory-herstel blijft ook draaien.

### Een lokale checkout gebruiken

Om de plugin vanuit een lokale broncheckout te draaien in plaats van de npm-release: `bun install && bun run build` in de checkout, en wijs daarna de `plugins`-lijst naar de checkoutdirectory:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Wijs naar de pakketroot, niet naar `dist/` of een enkel bestand. OpenCode lost een directoryplugin op door terug te vallen op `<directory>/index` (OpenCode leest geen `package.json` `exports`/`main` voor een padspecificatie in huidige releases), daarom levert deze repository een dunne root-`index.js` die de gebouwde v2-entrypoint uit `dist/plugin.js` opnieuw exporteert, en een root-`tui.js` die `dist/tui.js` opnieuw exporteert voor de TUI-companion. Een pad naar een bestand wordt geweigerd (`configured plugin path must be a directory`), en een directory zonder root-`index.js` wordt stilzwijgend overgeslagen.

### Optionele databaseversleuteling in rust

De plugin beheert databaseversleuteling niet langer zelf — de oude opties `databaseEncryptionEnabled`, `databaseEncryptionKey` en `databaseEncryptionCipher` zijn verwijderd. Herinneringen leven in je sqld-server, dus beveilig ze op die laag: draai sqld op een versleuteld volume, beperk netwerktoegang tot `sqldUrl` en stel `sqldAuthToken` in wanneer de server authenticatie vereist. De token accepteert `env://…` en `file://…`-referenties, zodat hij niet in platte tekst in het configbestand hoeft te staan.

**Windows:** gebruik `%USERPROFILE%\.config\opencode\opencode.json` (bijvoorbeeld `C:\Users\<you>\.config\opencode\opencode.json`). Deze plugin leest **niet** `%APPDATA%` of `%LOCALAPPDATA%` voor zijn OpenCode-pluginentry — plaats het bestand onder `.config\opencode` in je gebruikersprofiel en herstart OpenCode. Als de plugin niet verschijnt, controleer dat pad en herstart opnieuw.

De plugin wordt automatisch gedownload bij de volgende start.

## Dagelijks gebruik

Je hoeft OpenCode **niet** te vragen dingen te “onthouden” om de plugin te laten werken. Met de standaardinstellingen bouwt het geheugen zich op terwijl je werkt.

### Typische dagelijkse workflow

1. Schakel de plugin in (zie [Aan de slag](#aan-de-slag)) en herstart OpenCode.
2. Configureer een AI-provider voor auto-capture — aanbevolen: `opencodeProvider` + `opencodeModel` (of `"opencodeModel": "inherit"`). Details onder [Auto-capture AI-provider](#auto-capture-ai-provider).
3. Werk normaal in OpenCode. Wanneer een sessie idle wordt, extraheert auto-capture memorabele technische context en slaat die op.
4. In latere sessies worden relevante herinneringen in de context geïnjecteerd (zie `chatMessage` / compaction-instellingen). Blader of bewerk ze in de web-UI op `http://127.0.0.1:4747`.
5. Gebruik de `memory`-tool wanneer je iets meteen wilt opslaan of ophalen (zie [Gebruiksvoorbeelden](#gebruiksvoorbeelden)).

### Automatisch versus handmatig geheugen

| Aanpak                                                   | Wanneer het draait                                 | Wat jij doet                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Auto-capture** (`autoCaptureEnabled: true`, standaard) | Na conversatiebeurten wanneer de sessie idle wordt | Niets — extractie is automatisch                                                                   |
| **Handmatig** `memory`-tool / commands                   | Op verzoek                                         | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import`, `help` |

Handmatige search/add/list werken nog steeds, ook als auto-capture geen provider geconfigureerd heeft. Auto-capture en gebruikersprofiel-leren hebben een provider nodig die structured/tool-call-output kan teruggeven.

### Geheugen versus AGENTS.md versus Skills

| Opslaan in **geheugen**                                                             | Opslaan in **AGENTS.md** / statische docs                | Opslaan als **Skills** (web-UI / `skills.db`)                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Projectspecifieke beslissingen, bugpatronen, “we hebben X geprobeerd en het faalde” | Stabiele regels en workflows die zelden wijzigen         | Herbruikbare procedures die de agent on demand laadt          |
| Gebruikersvoorkeuren ontdekt over sessies                                           | Altijd-aan codingconventies en proces                    | Door het team bewerkbare skill-packs via dezelfde opslag      |
| Feiten die je over chats heen moeten volgen                                         | Instructies die elke agent moet zien, ongeacht retrieval | OpenCode-native `skill`-tool (V2-pluginbrug)                  |

Vuistregel: blijvende always-on projectinstructies → `AGENTS.md`; groeiende werkcontext → geheugen; herbruikbare on-demand procedures → **Skills**.

#### Shared Skills (V2)

- Skills aanmaken/bewerken in de web explorer (**Skills**-tab op `/skill-library`).
- Opgeslagen in `skills.db` onder het plugin-opslagpad (niet als geheugenvectoren).
- Op OpenCode **V2** registreert de plugin ingeschakelde skills via `ctx.skill.transform`, zodat de agent ze met de native `skill`-tool kan laden.
- Optionele HTTP-catalogus voor andere OpenCode-instanties: `"skills": ["http://127.0.0.1:4747/skills/"]` (serveert `/skills/index.json` en `/skills/<id>/<id>.md` — los van het UI-pad).
- REST: `GET/POST /api/skills`, `GET/PUT/DELETE /api/skills/:id`.

### Health-stats

De **Stats**-tab van de web-UI (op `/stats`) toont in één oogopslag de gezondheid van het geheugensysteem: totalen per scope, geheugentellingen per shard met waarschuwingen voor stale/ontbrekende shards en een same-tag-duplicatieproxy, de actieve gebruikersprofielversie, en een 14-daagse activiteitsserie (captures, overgeslagen captures, profiel-/compaction-injecties en op message gebucketteerde fouten) uit de gestructureerde pluginlogs in `~/.opencode-mem/`. Alleen-lezen — `GET /api/stats` — en degradeert per sectie als een database ontbreekt, zodat rapportage tijdens incidenten doorgaat.

### Intelligente promptgebaseerde geheugenextractie

Die zin in de functielijst is **auto-capture**: na een conversatie vat een achtergrond-AI-verzoek technisch werk samen en slaat het op als geheugen. Er is geen speciale prompt van jou nodig. Het gebruikt `opencodeProvider` / `opencodeModel` wanneer die zijn ingesteld, anders de handmatige `memoryProvider`-fallback.

### Gebruikersprofiel

Het **gebruikersprofiel** is een aparte, cross-projectsamenvatting van hoe jij wilt werken (voorkeuren, gewoonten). Het wordt bijgewerkt op een interval (`userProfileAnalysisInterval`, standaard elke 10 geanalyseerde prompts), getoond in de profielweergave van de web-UI, en leesbaar via `memory({ mode: "profile" })`. Je vult het voor normaal gebruik niet handmatig — profiel-leren vult het wanneer een provider klaar is. De uitvoertaal volgt `autoCaptureLanguage` (standaard `"auto"`, spiegelt de taal van je prompts), dezelfde instelling als voor auto-captured herinneringen.

**“No profile found. Keep chatting to build your profile.”** is de verwachte lege toestand, geen crash. Profiel-leren heeft nodig:

1. Auto-capture die draait met een bereikbare provider (`opencodeProvider` + `opencodeModel`, of een complete handmatige fallback met `memoryModel` + `memoryApiUrl`).
2. Genoeg sessieprompts sinds de laatste analyse — minstens `userProfileAnalysisInterval` (standaard **10**).
3. Dat die provider structured/tool-call-output ondersteunt (zelfde eis als auto-capture).

Als je een tijd hebt gechat en het bericht nog steeds ziet, controleer of auto-capture echt afgaat in de logs en of de geconfigureerde provider slaagt (mislukte profielanalyse verbergt zich niet meer achter een generieke lege toestand wanneer de provider een fout geeft).

### Web-UI

Open `http://127.0.0.1:4747` om de memory–prompt timeline te bekijken, captures te inspecteren en het gebruikersprofiel te beheren. De UI heeft vijf weergaven: **Project memories** (`/project-memories`), **User profile** (`/user-profile`), **Skill library** (`/skill-library`), **Markdown vault** (`/markdown-vault`) en **Stats** (`/stats`). Wijzig de poort met `webServerPort`, of stel `webServerEnabled: false` in om zonder de web-UI te draaien. Als je de server buiten loopback bindt, zie [Web-UI HTTP Basic Auth](#web-ui-http-basic-auth).

## Gebruiksvoorbeelden

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

Open de webinterface op `http://127.0.0.1:4747` voor visueel bladeren en beheer van herinneringen.

**Netwerkbindingsbeveiliging:** Houd `webServerHost` op `127.0.0.1` tenzij je de UI bewust blootstelt. Binding aan `0.0.0.0` (of een niet-loopback-host) vereist `webServerApiToken`; alle `/api/*`-verzoeken moeten dan `Authorization: Bearer <token>` of `X-Opencode-Mem-Token` meesturen. Open de UI met `?apiToken=<token>` zodat de browser die opslaat en meestuurt.

Dimensiemigraties genereren eerst elke nieuwe embedding, importeren die in een tijdelijke geïndexeerde shard, verifiëren het rijaantal, en vervangen pas daarna het originele bestand. Mislukte migraties laten de bronsshard onaangeroerd.

## Essentiële configuratie

Configureer op `~/.config/opencode/opencode-mem.jsonc`:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (zelfde `.config\opencode`-directory als hierboven — niet AppData). Standaardopslag lost op naar `%USERPROFILE%\.opencode-mem\data` (de `~`-vorm expandt ook op Windows naar je gebruikershome).

De plugin maakt bij de eerste start een volledig becommentarieerd template op dit pad. Voor elke instelling en commentaar, zie [`opencode-mem.example.jsonc`](../../opencode-mem.example.jsonc).

Vaak aangepaste opties op het hoogste niveau:

| Optie                                                                 | Standaard                       | Wat het doet                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `sqldUrl`                                                             | `"http://127.0.0.1:8080"`       | URL van de libSQL-server (`sqld`) die de herinneringen bevat.                                                                         |
| `sqldAuthToken`                                                       | _(leeg)_                        | Auth-token voor sqld; accepteert `env://…` / `file://…`-referenties.                                                                  |
| `storagePath`                                                         | `"~/.opencode-mem/data"`        | Lokale caches en Markdown vault-indexen; de herinneringen zelf leven in sqld.                                                         |
| `webServerEnabled` / `webServerPort` / `webServerHost`                | `true` / `4747` / `"127.0.0.1"` | Schakelaar, poort en bindadres van de Web UI-server.                                                                                  |
| `autoCaptureEnabled`                                                  | `true`                          | Vat inactieve sessies samen tot herinneringen (vereist een provider, zie [Auto-Capture AI Provider](#auto-capture-ai-provider)).      |
| `similarityThreshold` / `maxMemories`                                 | `0.6` / `10`                    | Minimale gelijkenisscore en maximaal aantal resultaten bij het zoeken in herinneringen.                                               |
| `injectProfile`                                                       | `true`                          | Injecteert het gebruikersprofiel (voorkeuren, patronen, workflows) in de AI-context.                                                  |
| `deduplicationEnabled` / `deduplicationSimilarityThreshold`           | `true` / `0.9`                  | Detecteert en verwijdert dubbele herinneringen.                                                                                       |
| `autoCleanupEnabled` / `autoCleanupRetentionDays`                     | `true` / `30`                   | Verwijdert maximaal één keer per dag prompts die ouder zijn dan de bewaartermijn en herinneringen die niet binnen die termijn zijn bijgewerkt. Vastgezette herinneringen blijven behouden. |
| `showAutoCaptureToasts` / `showUserProfileToasts` / `showErrorToasts` | `true`                          | Toasts voor auto-capture, profielupdates en fouten.                                                                                   |
| `autoUpdate`                                                          | `true`                          | Wist de gecachte installatie van OpenCode wanneer er een nieuwere npm-release beschikbaar is.                                         |

### Markdown-vault-backend (`memoryBackend`)

Standaard leven herinneringen alleen in sqld. Optioneel kun je een **generieke Markdown-map** als bron van waarheid zetten (Obsidian-/Raneto-compatibele platte `.md`-bestanden — geen Obsidian-specifieke integratie):

```jsonc
{
  "memoryBackend": "markdown",
  "markdownPath": "~/Documents/LLM-Wiki",
}
```

| Sleutel         | Standaard    | Wat het doet                                                                                                                                       |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryBackend` | `"database"` | `"database"` houdt content in sqld. `"markdown"` gebruikt alle `.md`-bestanden onder `markdownPath` als bron van waarheid.                          |
| `markdownPath`  | —            | Vereist wanneer `memoryBackend` `"markdown"` is. Absoluut of `~/…`-pad naar de vault-map. Geen aparte memory-submap — het pad _is_ de store.      |

Wanneer Markdown-modus aan staat:

- Door de plugin gemaakte herinneringen worden als `{id}.md` met YAML-frontmatter + body geschreven.
- Bestaande notities in de map (elke Markdown-paginastijl) worden geïmporteerd/geïndexeerd; sqld is alleen een herbouwbare semantic-search-index.
- Bestandsadds/bewerkingen/verwijderingen worden bewaakt en opnieuw geïndexeerd; de web-UI toont alleen in deze modus een **Markdown**-sidebarpagina (status, bestandenlijst, reindex).
- Overschakelen naar Markdown herbouwt de index vanuit de map. Rijen die alleen in de database staan en geen bijpassend bestand hebben, worden alleen verwijderd na een leesbare, volledige scan van een niet-lege vault. Exporteer eerst met `memory export` als je oude databaseherinneringen wilt bewaren.
- Bij het synchroniseren wordt verwijdering overgeslagen en verschijnt een waarschuwing als de vault ontbreekt, onleesbaar is, slechts gedeeltelijk is gescand of verwerkt, of geen Markdown-bestanden bevat; bestaande geïndexeerde herinneringen blijven behouden. Herstel de vault of los het probleem op en indexeer daarna opnieuw. Wil je de geïndexeerde herinnering van het laatste bestand bewust verwijderen, verwijder die herinnering dan expliciet via de tool of web-UI.
- Bij een gezonde, niet-lege vault worden geïndexeerde herinneringen waarvan de bestanden ontbreken nog steeds permanent verwijderd. Exporteer of maak eerst een back-up: deze beveiligingen vervangen geen back-up en herkennen geen onvolledige synchronisatie die eruitziet als een gezonde, niet-lege vault.

### Chatberichtvastlegging en -injectie (`chatMessage`)

Deze instellingen staan onder de `chatMessage`-sleutel in `~/.config/opencode/opencode-mem.jsonc`:

| Optie                                                  | Standaard        | Wat het doet                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                              | `true`           | Leg geschreven gebruikersprompts vast en injecteer geheugencontext.                                                                                                                                                                                                                                                             |
| `injectOn`                                             | `"first"`        | Bij `recall: "recent"`: injecteer bij het eerste gebruikersbericht, of bij `"always"` elke geschreven beurt. Met `recall: "relevant"` / `"both"` wordt de context altijd bij elke geschreven beurt ververst (issue #460).                                                                                                       |
| `recall`                                               | `"relevant"`     | Hoe geïnjecteerde herinneringen worden gekozen: `"relevant"` maakt een embedding van het gebruikersbericht en voert elke beurt een vectorzoekopdracht uit; `"recent"` behoudt de oude lijst van de nieuwste N; `"both"` geeft de voorkeur aan relevante en vult resterende plaatsen aan met recente.                            |
| `recallScope`                                          | `"default"`      | Bereik voor auto-recall: `"default"` volgt `memory.defaultScope`, of forceer `"project"` / `"all-projects"`. Bij zoeken in alle projecten krijgen treffers uit het huidige project een kleine similarity-boost.                                                                                                                 |
| `similarityThreshold`                                  | (top-level)      | Optionele ondergrens per injectie; anders wordt de top-level `similarityThreshold` gebruikt.                                                                                                                                                                                                                                    |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | Hoeveel herinneringen de geïnjecteerde context bevat, of herinneringen uit de huidige sessie worden uitgesloten, en een optionele leeftijdslimiet in dagen.                                                                                                                                                                     |
| `filterInjectedPrompts`                                | `true`           | Sla prompttekst over die door de host of andere OpenCode-plugins is geïnjecteerd (systeemherinneringen, orchestratierichtlijnen, achtergrondtaakmeldingen) zodat die nooit wordt opgeslagen alsof de gebruiker die heeft getypt.                                                                                                |
| `injectionMarkers`                                     | built-ins        | Extra markers die geïnjecteerde blokken identificeren; worden toegevoegd aan de ingebouwde lijst, vervangen die nooit.                                                                                                                                                                                                          |
| `captureChildSessions`                                 | `false`          | Leg prompts vast van orchestrator-childsessies (sessies met een `parentID`, bijv. OpenCode task/subagent-children). Hun “user”-berichten worden door de parent-agent geschreven, niet door jou, en worden standaard niet opgeslagen, auto-captured, gebruikt voor profiel-leren, of van geïnjecteerde geheugencontext voorzien. |

Uitsluitingen op basis van sessie en leeftijd worden toegepast vóór de limiet voor
geïnjecteerde herinneringen. Uitgesloten herinneringen nemen daardoor geen plaatsen
in die voor geschikte herinneringen beschikbaar zijn. Met `chatMessage.maxMemories`
op `0` wordt het injecteren van projectherinneringen uitgeschakeld; het
gebruikersprofiel kan nog steeds worden geïnjecteerd als dit is ingeschakeld.

Geïnjecteerde geheugentags geven `selection="recent"` of `selection="semantic"` aan.
Recente selecties (inclusief fallback en recente aanvulling in `both`) hebben geen
numerieke score. Semantische selecties bevatten een eindige `retrieval_score` wanneer
beschikbaar; dit is een rangschikkingssignaal dat de boost voor het huidige project kan
bevatten, geen waarschijnlijkheid van relevantie of feitelijke juistheid. Ontbrekende of
ongeldige scores worden weggelaten. Dit vervangt het vroegere promptattribuut
`relevance="...%"` zonder de selectie, volgorde, inhoud of herkomst van herinneringen te
wijzigen. Compaction behoudt het bestaande formaat.

Wanneer semantische recall mislukt (bijvoorbeeld omdat embedding niet beschikbaar is),
vallen `relevant` en `both` terug op de bestaande recente lijst met dezelfde
beperkingen voor bereik, aantal, sessie en leeftijd. Een geslaagde zoekopdracht zonder
geschikte treffers blijft leeg in `relevant`; `both` vult zoals gebruikelijk aan met
recente herinneringen. Waarschuwingen over gedeeltelijke shards activeren geen
fallback. Als ook de recente fallback mislukt, blijft recall leeg en niet-fataal. Het
fallbackgedrag bij een ontbrekende query en het verversen per beurt blijven ongewijzigd.

### Update-on-capture (optioneel)

Optioneel pad om herinneringen actueel te houden wanneer feiten veranderen. Met
`updateOnCaptureEnabled: true` embedt auto-capture de nieuwe samenvatting, zoekt
vergelijkbare herinneringen boven `updateOnCaptureSimilarityThreshold` (standaard
`0.75`) en laat het capture-model kiezen tussen `add`, `update` (in-place
herschrijven) of `supersede` (nieuw opslaan + oud soft-deleten naar de prullenbak).
Vastgezette (pinned) herinneringen worden overgeslagen. Standaard uit, zodat
bestaande installaties add-only blijven.

```jsonc
"updateOnCaptureEnabled": true,
"updateOnCaptureSimilarityThreshold": 0.75,
"updateOnCaptureMaxCandidates": 5,
```

Tip: bij `Xenova/nomic-embed-text-v1` verbetert `embeddingUseTaskPrefixes: true`
(en eventueel een lagere recall-`similarityThreshold`) vaak de matchkwaliteit voor
langere herinneringen. Prefixes blijven standaard opt-in.

### Dreaming (optionele geheugenconsolidatie)

Optionele achtergrondpass die **gerelateerde** herinneringen vindt via
`dreaming.relatedThreshold` (standaard `0.75`, onafhankelijk van
`deduplicationSimilarityThreshold`), ze via `opencodeProvider` / `opencodeModel`
met `merge` / `update` / `supersede` / `keep` / `flag` (tegenstrijdigheden)
consolideert, en vervangen rijen soft-deletet naar herstelbare prullenbak.
Vastgezette herinneringen blijven onaangeroerd. Met `dreaming.crossProject: true`
(of `memory.defaultScope: "all-projects"`) groepeert dreaming over projecttags;
user-scope blijft gescheiden. Configureer onder `dreaming` in
`opencode-mem.jsonc` (`enabled` standaard `false`). De web-UI toont **Trash** en
**Dream**. Soft-verwijderde rijen worden na `dreaming.trashRetentionDays` hard
opgeschoond.

### Embeddings kiezen / configureren

Embeddings voeden similarity search voor herinneringen en het gebruikersprofiel. Configureer ze in `~/.config/opencode/opencode-mem.jsonc`. **Remote embeddings zijn de enige backend** — het lokale ONNX/transformers-model is verwijderd omdat de native bindings niet voor elk platform beschikbaar zijn. Zowel `embeddingApiUrl` als `embeddingApiKey` zijn vereist: de plugin toont een opstartfout en weigert herinneringen op te slaan of te zoeken als een van beide ontbreekt.

**Remote (OpenAI-compatibel):** de plugin roept `{embeddingApiUrl}/embeddings` aan met een Bearer-token. `embeddingApiKey` accepteert dezelfde geheime formaten als `memoryApiKey` (`literal`, `env://…`, `file://…`). Het endpoint moet vectoren met een consistente dimensie teruggeven; stel `embeddingDimensions` in als je endpoint die niet in een ingebouwd preset rapporteert.

| Sleutel                    | Rol                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `embeddingApiUrl`          | **Vereist.** Basis-URL van een OpenAI-compatibele embeddings-API (geen trailing path voorbij `/v1`).                            |
| `embeddingApiKey`          | **Vereist.** API-sleutel voor dat endpoint; accepteert `env://…` / `file://…`-referenties.                                       |
| `embeddingModel`           | Modelnaam die je endpoint aanbiedt. Standaard: `Xenova/nomic-embed-text-v1` (ook gebruikt voor dimensieopzoeking).              |
| `embeddingDimensions`      | Optionele override; meestal weglaten — dimensies worden opgezocht uit een ingebouwde map.                                       |
| `embeddingQueryPrefix`     | Prefix voor query-task-embeddings. Unset → modelpreset of Nomic wanneer `embeddingUseTaskPrefixes` true is. Expliciete `""` schakelt uit. |
| `embeddingDocumentPrefix`  | Prefix voor document-task-embeddings (zelfde resolutieregels als `embeddingQueryPrefix`).                                       |
| `embeddingUseTaskPrefixes` | Opt-in Nomic `search_query:` / `search_document:`-prefixes wanneer custom/preset-prefixes unset zijn. Standaard `false`.         |

Voorbeeld — OpenAI:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Voorbeeld — een zelfgehost endpoint:

```jsonc
{
  "embeddingApiUrl": "http://127.0.0.1:8765/v1",
  "embeddingApiKey": "local-dev-key",
  "embeddingModel": "nomic-embed-text-v1.5",
}
```

Wijzigen van `embeddingModel`, dimensies of task-prefixes kan opnieuw embedden van opgeslagen herinneringen vereisen zodat store- en queryvectoren uitgelijnd blijven. Kies liever één keer een model (en prefixinstellingen) en blijf daarbij voor een gegeven sqld-database.

### Geheugenbereik

- `scope: "project"`: query alleen het huidige project. Dit is de standaard.
- `scope: "all-projects"`: query `search` / `list` over alle projectshards.
- `memory.defaultScope` stelt het standaard querybereik in wanneer geen expliciet bereik is opgegeven.

### Web-UI HTTP Basic Auth

Wanneer `webServerHost` op iets anders dan loopback staat (bijvoorbeeld `0.0.0.0`), is de web-UI bereikbaar voor iedereen op het netwerk. Om je herinneringen van het LAN te houden, beveilig de webserver met HTTP Basic Auth via hetzelfde configbestand als voor al het andere:

```jsonc
{
  "webServerHost": "0.0.0.0", // optioneel: UI bereikbaar vanaf het LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optioneel, standaard de huidige OS-gebruiker
}
```

| Veld                    | Standaard              | Effect                                                                                                                          |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `webServerAuthPassword` | _(leeg)_               | Wanneer gezet, eist de server HTTP Basic Auth-credentials bij elk verzoek. Laat leeg om het open-by-default-gedrag te behouden. |
| `webServerAuthUsername` | OS-gebruiker (`$USER`) | Gebruikersnaam vereist door de Basic Auth-challenge.                                                                            |

`webServerAuthPassword` accepteert dezelfde geheime formaten als `memoryApiKey`:

- een letterlijke string (eenvoudig, prima voor persoonlijke machines),
- `env://SOME_ENV_VAR` om de waarde bij start uit de omgeving te halen,
- `file:///path/to/secret` om die uit een bestand te lezen (`chmod 600` aanbevolen — de plugin waarschuwt als het bestand world-readable is).

De browser toont zijn native Basic Auth-dialoog en onthoudt de credentials voor de huidige sessie; alle browservensters sluiten wist ze, dus opnieuw openen van de browser vereist opnieuw inloggen. Credentials worden vergeleken met een constant-time check, en de niet-geauthenticeerde 401-response draagt `Cache-Control: no-store` zodat geen intermediaire cache die opnieuw speelt. CORS wordt ook versoepeld zodra auth aan staat, zodat andere tools op hetzelfde LAN na authenticatie met de API kunnen praten.

### Eén projectgeheugen delen over geneste repo’s

Standaard wordt een project geïdentificeerd door zijn omsluitende git-repository, dus elke
fysieke git-repo krijgt zijn eigen geïsoleerde geheugenstore. Dat is verkeerd voor
multi-repo-workspaces — bomen beheerd door Google [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md),
monorepo’s, of elke layout waarin meerdere geneste git-repositories tot één
logisch project behoren — omdat elke subrepository silogeïsoleerd zou zijn.

Plaats een leeg **`.opencode-mem-project`**-markerbestand bij de workspaceroot:

```
my-workspace/
├── .opencode-mem-project   ← workspaceroot
├── kernel/                 (eigen git-repo)
├── userspace/              (eigen git-repo)
└── tools/                  (eigen git-repo)
```

Elke sessie die ergens onder de marker start, lost dan op naar die
root en deelt één geheugenstore, ongeacht in welke subrepo de werkdirectory
staat:

```sh
touch ~/my-workspace/.opencode-mem-project
```

De marker wordt opgezocht door omhoog te lopen vanaf de werkdirectory die elk
codepad al doorgeeft (de werkdirectory van de plugin, de `process.cwd()` van de web-API),
dus identiteit is **directorygedreven en procesonafhankelijk**.
Het steunt niet op omgevingsvariabelen of een globale configwaarde, die
hier onbetrouwbaar zouden zijn: opencode-mem draait over meerdere opencode-processen
die één webserver delen, en slechts sommige van die processen dragen een
gegeven env-var. Met de marker wordt de projectroot altijd afgeleid van waar
de sessie daadwerkelijk draait.

De marker heeft voorrang op git-detectie. Wanneer aanwezig, wordt de
eigen git-remote van de subrepo bewust genegeerd (die zou slechts één
geneste repository beschrijven). Zonder marker blijft het gedrag ongewijzigd (git-gebaseerde
identiteit).

### Projectherinneringen verplaatsen of herstellen

opencode-mem koppelt projectshards aan een hash van de projectidentiteit. Een repository
verplaatsen (OS-migratie, padreorganisatie, overschakelen van een Windows-mount
naar een native pad) kan daarom de oude shard wees maken onder
`~/.opencode-mem/data/projects/` terwijl een nieuwe lege shard wordt aangemaakt voor het
nieuwe pad.

Dit zijn OpenCode `memory`-toolaanroepen met JSON-argumenten, geen commands om
in een terminal te draaien. De issue-stijlnotatie `memory migrate --from ...` mappt
naar `memory({ mode: "migrate", fromPath: "..." })`.

**1. Lokale verplaatsing wanneer je het oude pad nog kent**

Open OpenCode in de **nieuwe** projectdirectory. Het doelproject mag nog
geen herinneringen bevatten (migratie breekt ongewijzigd af bij conflict). Bekijk eerst de
gedetecteerde bron, bestemming en bestandsacties voordat je iets wijzigt:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Voor de veiligheid weigert migratie een bron waarvan de opgeslagen projectdirectory nog
bestaat. Als je bewust een actieve bron wilt verplaatsen, bekijk eerst de dry-run-
output en geef daarna `allowLinkedSource: true` mee. Originele bronsshard-
bestanden blijven behouden als timestamped `*.pre-path-migrate-*.bak`-backups.

**2. Oud pad is weg — ontdek eerst de wees-shard**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` rapporteert elke projecthash, opgeslagen `projectPath`, geheugenaantal,
en status (`current`, `linked`, `orphaned`, `missing-file`, `empty`, of
`ambiguous`). `fromHash` is de 16-tekens lowercase hexadecimale `scopeHash`
die deze call teruggeeft. Geef daaraan de voorkeur wanneer de oude directory niet meer bestaat of
meerdere shards hetzelfde opgeslagen pad bevatten, omdat git-gebaseerde identiteiten
niet altijd opnieuw kunnen worden berekend vanuit een ontbrekend pad.

**3. Cross-machine backup / restore**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export schrijft een geversionneerd JSON-document zonder vectoren. Import remappt de
herinneringen naar het huidige project en herberekent embeddings met het momenteel
geconfigureerde model. Import voegt herinneringen toe aan een bestaand project, maar dubbele
memory-ID’s breken de hele import af vóór schrijven; dit verschilt van `migrate`,
dat een leeg doel vereist.

Exportbestanden zijn plaintext en kunnen geheugeninhoud, gebruikersnamen/e-mailadressen,
repository-URL’s en absolute projectpaden bevatten. Bewaar ze als andere
gevoelige backups en verwijder ze wanneer ze niet meer nodig zijn. Volledig private entries
worden weggelaten, en gebruikersprofielen en prompthistorie zijn niet inbegrepen. Het
document bevat `schemaVersion: 1`; imports weigeren nieuwere niet-ondersteunde schema-
versies in plaats van te gokken.

### Auto-capture AI-provider

Auto-capture draait een achtergrond-AI-verzoek om technisch werk samen te vatten en als geheugen op te slaan. Het heeft een van de onderstaande providerconfiguraties nodig.

**Aanbevolen:** Gebruik een provider die al in opencode is geauthenticeerd en structured output ondersteunt:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

De plugin stuurt structured-output-verzoeken naar de session-API van opencode in plaats van providerendpoints rechtstreeks aan te roepen, zodat opencode auth, tokenvernieuwing en providerrouting beheert. De providernaam moet overeenkomen met een entry uit `opencode providers list`, en het geselecteerde model moet structured JSON-output via opencode ondersteunen.

Optioneel kun je een model-reasoningvariant vastzetten met `"opencodeVariant": "xhigh"` (bijv. voor grok-4.7). Die wordt toegepast op de interne LLM-calls van de plugin (auto-capture-samenvattingen, profiel-leren, profielopschoning), ook wanneer `opencodeModel` `"inherit"` is, zodat achtergrondwerk een ander reasoningniveau kan gebruiken dan de interactieve sessie.

Trage reasoningmodellen (of zeer grote profielprompts) kunnen het standaard 90 s structured-output-budget overschrijden. Stel `"opencodeTimeoutMs"` (milliseconden) in om het te verlengen voor interne structured-output-calls (auto-capture-samenvattingen, profiel-leren) — bijv. `"opencodeTimeoutMs": 180000` voor 3 minuten. Waarden worden geclampt tot 10000..600000; de standaard blijft 90000. Numerieke strings worden gecoeerd. Profielopschoning gebruikt een aparte, langere timeout.

Ondersteunde providers: elke provider uit `opencode providers list` (bijv. `anthropic`, `openai`, `github-copilot`, `openrouter`, ...).

**Ingebouwde Free / Zen-modellen** onder provider-id `opencode` (bijv. `big-pickle`) kunnen de interne structured-output-sessies van de plugin vaak niet draaien — OpenCode kan ze buiten interactieve chat weigeren. Geef de voorkeur aan een geauthenticeerde provider uit `opencode providers list`, of gebruik `"opencodeModel": "inherit"` zodat capture het model volgt dat je al in de sessie gebruikt.

Als `autoCaptureEnabled` `true` is (standaard) maar noch `opencodeProvider`/`opencodeModel` noch een complete handmatige fallback is geconfigureerd, logt de plugin een waarschuwing en toont een opstarttoast (wanneer `showErrorToasts` is ingeschakeld), zodat ontbrekende config zichtbaar is zonder door logs te hoeven zoeken.

Als `opencodeProvider` en `opencodeModel` zijn ingesteld, hebben ze standaard voorrang op de handmatige `memoryProvider`-instellingen hieronder (`"autoCaptureProviderOrder": "opencode-first"`). Stel `"autoCaptureProviderOrder": "external-first"` in om de handmatige API te verkiezen wanneer beide zijn geconfigureerd (handig wanneer de session-API van de host druk/traag is); het andere kanaal wordt als fallback gebruikt. Verlaag `"opencodeTimeoutMs"` om sneller van het opencode-kanaal over te schakelen.

**Volg het sessiermodel:** stel `"opencodeModel": "inherit"` in om op call-tijd een concreet OpenCode-model te gebruiken in plaats van een vastgezette id. Voor **auto-capture** wordt elke prompt via de `chat.params`-hook vastgelegd en hergebruikt het capture-verzoek provider/model van die prompt. Voor **profiel-leren** en andere structured-output-paden (die niet aan één gebruikersbericht zijn gebonden) hergebruikt `inherit` eerst het laatste model dat de host via `chat.params` / de V2-context-hook meldde, en valt daarna terug op OpenCode’s `model.json`-recentelijst indien aanwezig (met voorkeur voor de geconfigureerde `opencodeProvider`). OpenCode v2 schrijft `model.json` niet meer; daar is het in-process-sessiemodel de primaire fallback. Het letterlijke model-id `inherit` versturen is nooit geldig en veroorzaakte eerder `ProviderModelNotFoundError: Model not found: <provider>/inherit` op die paden. `opencodeProvider` blijft vereist als normale configgate.

**Fallback:** Handmatige API-configuratie (als je geen opencodeProvider gebruikt):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API-sleutelformaten:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Handmatige `memoryProvider`-modi:

- `openai-chat`: OpenAI Chat Completions-compatibele API met tool/function calling. Dit kan werken met compatibele proxies zoals LiteLLM alleen wanneer het geselecteerde upstream-model en de proxy tool calls behouden.
- `openai-responses`: OpenAI Responses API met function-call-output.
- `anthropic`: Anthropic Messages API met tool use.
- `minimax`: MiniMax Anthropic Messages-compatibel endpoint. Stel `memoryApiUrl` in op het globale endpoint (`https://api.minimax.io`) of het [China-endpoint](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api.md) (`https://api.minimax.cn`); het pad `/anthropic/v1/messages` en de header `x-api-key` worden automatisch toegepast. Gebruik `MiniMax-M3.1-Flash` (aanbevolen) of `MiniMax-M3`, beide met een 1.000.000-token context. Flash denkt altijd; stel optioneel `memoryExtraParams` in op `{ "output_config": { "effort": "max" } }` met `low`, `medium`, `high`, `xhigh` of `max` (standaard). Flash weigert uitgeschakeld thinking en effort `none`, en ondersteunt geen `service_tier`. M3-thinking staat op dit endpoint standaard uit; zet het aan met `{ "thinking": { "type": "adaptive" } }`. Model-ID’s blijven expliciet geconfigureerd; bestaande custom of legacy-ID’s worden ongewijzigd doorgestuurd. Zie de [MiniMax-compatibiliteitsreferentie](https://platform.minimax.io/docs/api-reference/text-anthropic-api.md).
- `orcarouter`: OpenAI-compatibele modelgateway met namespaced model-ID’s. `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.orcarouter.ai/v1` en `orcarouter/auto` (een routingalias die per verzoek een capabel model kiest). Als je `memoryModel` instelt, gebruik een namespaced ID zoals `openai/gpt-5.5` of `deepseek/deepseek-v4-flash`; OrcaRouter weigert bare modelnamen. Voorbeeld:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) draait ook gateway-level, zero-trust security voor AI-agents op hetzelfde endpoint — screening van elke prompt/response en governance van elke tool call op default-deny-basis, zonder wijzigingen in applicatiecode.
- `atlas-cloud`: OpenAI-compatibel Chat Completions-preset voor [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.atlascloud.ai/v1` en `deepseek-ai/deepseek-v4-pro`. Als `memoryApiKey` wordt weggelaten, wordt `ATLASCLOUD_API_KEY` uit de omgeving gebruikt. Voorbeeld:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://api.atlascloud.ai`.
- `cheaper-inference`: OpenAI-compatibel Chat Completions-preset voor [Cheaper Inference](https://cheaperinference.com). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.cheaperinference.com/v1` en `gpt-5.4-mini`. Als `memoryApiKey` wordt weggelaten, wordt `CHEAPER_INFERENCE_API_KEY` uit de omgeving gebruikt. Voorbeeld:
  ```jsonc
  "memoryProvider": "cheaper-inference",
  "memoryApiKey": "env://CHEAPER_INFERENCE_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://api.cheaperinference.com`.
- `api-route`: OpenAI-compatibel Chat Completions-preset voor [API Route](https://www.api-route.com/en/docs/quickstart). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://global.api-route.com/v1` en `gpt-6.1-sol`. Als `memoryApiKey` wordt weggelaten, wordt `API_ROUTE_API_KEY` uit de omgeving gebruikt. Voorbeeld:
  ```jsonc
  "memoryProvider": "api-route",
  "memoryApiKey": "env://API_ROUTE_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://global.api-route.com`.
- `runcrate`: OpenAI-compatibel Chat Completions-preset voor [Runcrate](https://www.runcrate.ai). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.runcrate.ai/v1` en `deepseek-ai/DeepSeek-V4.1-Flash`. Als `memoryApiKey` wordt weggelaten, wordt `RUNCRATE_API_KEY` uit de omgeving gebruikt. Voorbeeld:
  ```jsonc
  "memoryProvider": "runcrate",
  "memoryApiKey": "env://RUNCRATE_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://api.runcrate.ai`.
- `cloudgpu`: OpenAI-compatibel Chat Completions-preset voor [CloudGPU](https://cloudgpu.app). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://cloudgpu.app/v1` en `deepseek-v4.1-flash`. Als `memoryApiKey` wordt weggelaten, wordt `CLOUDGPU_API_KEY` uit de omgeving gebruikt (maak een key aan via https://cloudgpu.app/api/console; API-docs: https://cloudgpu.app/api/docs). Voorbeeld:
  ```jsonc
  "memoryProvider": "cloudgpu",
  "memoryApiKey": "env://CLOUDGPU_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://cloudgpu.app`.
- `standardcompute`: OpenAI-compatibel Chat Completions-preset voor [Standard Compute](https://standardcompute.com). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.stdcmpt.com/v1` en `StandardCompute`. Als `memoryApiKey` wordt weggelaten, wordt `STANDARDCOMPUTE_API_KEY` uit de omgeving gebruikt (maak een key aan via https://standardcompute.com/dashboard; API-docs: https://docs.standardcompute.com). Voorbeeld:
  ```jsonc
  "memoryProvider": "standardcompute",
  "memoryApiKey": "env://STANDARDCOMPUTE_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://api.stdcmpt.com`.

Probleemoplossing:

- Auto-capture-fouten blokkeren handmatig `memory`-toolgebruik niet.
- Auto-capture bewaart begrensde finale assistenttekst en terminale tool-uitkomsten uit
  afgeleverde V1/V2-events voordat de vertraagde samenvatting draait. Normale idle-capture
  geeft nog steeds de voorkeur aan het live host-transcript; gereed pending bewijs is de fallback
  wanneer de sessie al weg is (verwijdering of startup-replay). Herstel is beperkt tot hetzelfde
  project en gebruikt de normale capture-provider en claim-queue. Het leidt geen voltooid werk
  af uit alleen het verzoek. Het verwijderen van een OpenCode-sessie verwijdert dit pending
  geheugenbewijs of reeds vastgelegde geheugens **niet**.
- Pending bewijs wordt vóór persistentie op private tags geredigeerd (inclusief tags die
  finale tekstdelen binnen één assistentbericht overspannen); reasoning, bijlagen, ruwe
  providermetadata, streaming-delta's en tool-argumenten worden uitgesloten. Limieten zijn 16 KiB per
  part, 16 parts per prompt, 256 parts globaal (maximaal 4 MiB tekst) en 64 KiB per
  capture. Truncatie wordt gemarkeerd; de oudste parts worden verwijderd wanneer het budget wordt overschreden.
  Bewijs verloopt na 24 uur en wordt bij volgende store-toegang opgeschoond. Het wordt gewist
  wanneer capture voltooit/overslaat of de prompt wordt verwijderd via bestaande verwijder-/retentie-
  paden. Dit zijn logische retentielimieten, geen veilige verwijdering van SQLite/WAL-back-ups.
- V2-events zijn een vluchtige stream: verbroken/gemiste events, onoplosbare prompt-
  koppeling en bewijs dat door verloop/verwijdering verloren is gegaan, kunnen niet worden hersteld. De garantie
  is capture uit bewijs dat is ontvangen, opgeslagen en door een idle/deleted-event als gereed is gecheckpoint,
  geen reconstructie van ongeziene of eerder verwijderde transcripts. Na dat
  checkpoint wordt de sessie verzegeld tegen late rebinds tot de volgende door de gebruiker geschreven
  input (V2 `session.inbox.delivered`, V1 user `message.updated`), zodat gebufferde parts
  gereed bewijs niet terug naar niet-gereed kunnen zetten. Een disconnect vóór het terminale
  checkpoint laat het gedeeltelijke bewijs uitgesteld tot een later checkpoint; een herstart
  gaat er niet van uit dat onvoltooid werk klaar is. V1 gebruikt expliciete parent-ID's van de assistent;
  V2 bevriest de afgeleverde input bij step-start in plaats van de laatst in de wachtrij geplaatste
  prompt te raden.
- Als de live host `Session.NotFoundError` meldt (of verwijdering/startup-replay geen
  gereed bewijs heeft), logt capture `skipped` / `session_not_found`, geeft zijn claim vrij
  zonder backoff of verbruik van retries, en slaat verdere host-afhankelijke lookups in die
  batch over. Latere prompts met gereed opgeslagen bewijs gaan nog steeds door. Een latere onafhankelijke idle
  kan opnieuw proberen. Reeds uitgeputte prompts worden niet herleefd. Andere fouten behouden hun
  bestaande retry-gedrag.
- Auto-capture-toevoegingen gebruiken een stabiele ID per project/prompt, zodat sequentiële crash/restart-
  replay het eerdere geheugen hergebruikt, inclusief soft-deleted records, in plaats van het in te voegen of
  te doen herleven. Dit claimt geen gedistribueerde exactly-once-semantiek voor optionele
  semantische update/supersede-operaties of elke multi-process crash-interleaving.
- Als auto-capture meldt dat een provider niet verbonden is, bevestig de providernaam met `opencode providers list` en configureer die provider eerst in opencode.
- Als een proxy of custom provider platte tekst teruggeeft in plaats van structured/tool-output, kies een ander model/provider of gebruik een van de handmatige providermodi hierboven.
- Voor modellen die `temperature` weigeren, voeg `"memoryTemperature": false` toe bij handmatige API-configuratie.
- Voor modellen die geforceerde tool calls weigeren (`tool_choice: "required"`, bijv. sommige thinking-modi), voeg `"forceToolChoice": false` toe bij `openai-chat` / `orcarouter` / `atlas-cloud` / `cheaper-inference` / `api-route` / `runcrate` / `cloudgpu` / `standardcompute`.
- Voor `opencodeProvider` / `opencodeModel` (bijv. DeepSeek V4 thinking) stuurt OpenCode nog steeds geforceerde `tool_choice` voor structured output. opencode-mem schakelt thinking uit op de interne `opencode-mem-structured`-agent (en past dat opnieuw toe in `chat.params` na variant-merge) zodat auto-capture en profiel-leren kunnen voltooien. Je interactieve chatagent blijft ongewijzigd. Als capture nog steeds faalt met een thinking/`tool_choice`-fout, kies een non-thinking model voor `opencodeModel` of configureer een complete handmatige fallback (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** auto-capture gebruikt OpenCode met je geauthenticeerde `anthropic`-provider. Geforceerde `format: json_schema` loopt vaak vast met Claude-auth, dus opencode-mem gebruikt een auth-behoudend **text-JSON**-pad voor `opencodeProvider: "anthropic"` (geen geforceerde `StructuredOutput`-tools; antwoord wordt met Zod geparsed). Een step-watchdog breekt runaway interne sessies nog steeds af na 2 stappen. Als capture nog steeds faalt, configureer een complete handmatige Anthropic API-key-fallback (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth kan niet buiten OpenCode worden hergebruikt.
- **Databaseverbindingsfouten:** bevestig dat sqld draait en dat `sqldUrl` ernaartoe wijst (`http://127.0.0.1:8080` standaard), en stel `sqldAuthToken` in als de server authenticatie vereist.
- **Fout "Remote embeddings are required":** stel zowel `embeddingApiUrl` als `embeddingApiKey` in; er is geen lokale embedding-backend.

## Publieke subpath-exports

Naast de hoofdplugin-entrypoint stelt `opencode-mem` één stabiele subpath bloot
die andere opencode-plugins rechtstreeks kunnen importeren. Zo hoef je geen
container-tagconventies te reverse-engineeren bij het schrijven van third-party tools die
in dezelfde geheugenstore lezen of schrijven.

### `opencode-mem/tags`

Canonieke container-taghelpers. Dezelfde functies die opencode-mem zelf gebruikt
om auto-captured herinneringen te scopen.

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

Tags die deze helpers produceren komen overeen met wat auto-capture schrijft, zodat third-party
plugins die `POST /api/memories` aanroepen in dezelfde shards belanden die de rest
van het systeem al begrijpt. Handgerolde tags waarvan de substring niet
`_project_` of `_user_` is, belanden in shadow shards die `/api/stats` en
`/api/memories` stilzwijgend filteren — deze helpers gebruiken voorkomt die valkuil.

## Ontwikkeling & bijdragen

Lokaal bouwen en testen:

```bash
bun install
bun run build
bun test
bun run quality
```

`bun run quality` voert `format:check`, `lint` en `typecheck` uit; `bun run format` herschrijft de opmaak.

De [docs](https://opencode-mem.zhafron.my.id/docs/) worden gegenereerd uit deze README en de vertalingen onder `.github/i18n/`; de [landingspagina](https://opencode-mem.zhafron.my.id) staat in `github-site/src/`. Elke README-kop moet in `github-site/docs-map.json` aan een docs-pagina zijn gekoppeld, anders mislukt de site-build. Bouw de site lokaal met `cd github-site && bun install && bun run build`.

Dit project zoekt actief bijdragen om de definitieve geheugenplugin voor AI-codingagents te worden. Of je bugs fixt, features toevoegt, documentatie verbetert of embeddingmodelondersteuning uitbreidt: je bijdragen zijn cruciaal. De codebase is goed gestructureerd en klaar voor verbetering. Open issues met de Issue- of Feature request-templates, en vul het pull request-template in wanneer je een PR indient — we reviewen en mergen bijdragen snel.

**README-vertalingen:** `README.md` (Engels) is de bron van waarheid. Wanneer je de inhoud wijzigt, werk dan de bestanden onder `.github/i18n/` (`README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md` en `README.nl.md`) bij zodat ze overeenkomen.

## Licentie & links

MIT-licentie — zie LICENSE-bestand

- **Website**: https://opencode-mem.zhafron.my.id
- **Documentatie**: https://opencode-mem.zhafron.my.id/docs/
- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **npm**: https://www.npmjs.com/package/opencode-mem
- **OpenCode-platform**: https://opencode.ai

Geïnspireerd door [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
