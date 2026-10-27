# AperioPlan – Handbuch für Entwickler

## Aufbau

```
shared/        Gemeinsame Fachlogik (TypeScript): Nummerierung, Status, Feiertage, Versionsprotokoll
server/        Fastify-Server (TypeScript, Node.js ≥ 20)
  migrations/  SQL-Migrationen (werden beim Start der Reihe nach eingespielt)
  src/routes/  REST-Schnittstellen je Fachbereich
  src/services Geschäftslogik (Sicherung, Dateien, CAD, E-Mail, Planer …)
  test/        Vitest-Tests gegen eine echte PostgreSQL-Datenbank
web/           React-Oberfläche (Vite)
cad-bridge/    CAD-Wächter für SolidWorks (C#/.NET 4.8), Export-Dienst, CLI
e2e/           Browser-Test des Testplans (Playwright)
deploy/        Caddy-Konfiguration, Updater
docs/          Handbücher, Beispiel-Plugin
```

## Entwicklungsumgebung

```sh
corepack enable
pnpm install
createdb aperio && createdb aperio_test        # PostgreSQL 14+
pnpm dev                                        # Server :3000, Oberfläche :5173 (mit Proxy)
pnpm test                                       # TEST_DATABASE_URL=postgres://… optional
pnpm typecheck && pnpm build
BASE_URL=http://localhost:3000 node e2e/testplan.mjs      # auf frischer Instanz
BASE_URL=http://localhost:3000 node e2e/screenshots.mjs   # Bildschirmfotos für README/Handbücher, ebenfalls frische Instanz
```

`e2e/screenshots.mjs` legt erfundene Beispieldaten an und schreibt die Bilder nach `docs/screenshots/` (hell und dunkel). Nach Änderungen an der Oberfläche einfach neu ausführen und die Bilder mit hochladen.

Umgebungsvariablen des Servers stehen in `server/src/config.ts`.

### Neue Version veröffentlichen

1. In `shared/src/version.ts` oben einen Eintrag in `CHANGELOG` ergänzen (erscheint unter „Was ist neu?“).
2. Versionsnummer in den `package.json` anheben.
3. Auf GitHub einen Release mit Tag `vX.Y.Z` erstellen – die Update-Prüfung der Installationen findet ihn automatisch.

### Datenbank ändern

Neue Datei `server/migrations/NNN_beschreibung.sql` anlegen – niemals bestehende Migrationen ändern. Neue Tabellen zusätzlich in `BACKUP_TABLES` (`server/src/services/backup.ts`) eintragen, damit sie gesichert werden.

## REST-Schnittstelle

Alle Endpunkte liegen unter `/api`. Authentifizierung entweder per Sitzungs-Cookie (Browser) oder per **API-Schlüssel**:

```sh
curl -H "Authorization: Bearer ap_…" https://plan.firma.de/api/projects
```

API-Schlüssel erzeugt jeder Benutzer unter **Einstellungen → API-Schlüssel**; sie haben dieselben Rechte wie der Benutzer.

Wichtige Endpunkte (Auswahl):

| Bereich | Endpunkte |
|---|---|
| Projekte | `GET/POST /projects`, `GET/PATCH /projects/:id`, `PUT /projects/:id/members`, `GET/POST /projects/:id/documents` |
| Aufgaben | `GET/POST /projects/:id/tasks`, `GET/PATCH/DELETE /tasks/:id`, `PUT /tasks/:id/dependencies`, `GET /tasks/mine` |
| Kommentare | `GET/POST /comments/:typ/:id` (typ = task, cad_item, kvp) |
| Dateien | `GET /projects/:id/files?path=`, `POST /projects/:id/files/upload?path=` (multipart), `GET /files/:id/download`, `GET /files/:id/versions` |
| Freigabelinks | `GET/POST /projects/:id/links`, `DELETE /links/:id`, öffentlich: `/public/links/:token/…` |
| CAD | `GET /cad/mask`, `POST /cad/numbers/preview`, `POST /cad/items`, `GET /cad/items?projectId=`, `GET /cad/resolve?fileName=`, `POST /cad/items/:id/checkout|checkin|undo-checkout|revise|state`, `GET /cad/items/:id/bom|where-used` |
| Ableitungen | `POST /cad/exports/claim`, `POST /cad/exports/:id/complete|fail` |
| Zeit | `GET /time/current`, `POST /time/clock-in|clock-out`, `GET /time/entries`, `POST /time/corrections`, `GET /time/export` |
| Urlaub | `GET /absences/balance`, `POST /absences`, `POST /absences/:id/decide`, `GET /calendar/team` |
| Chat | `GET /chat/channels`, `GET/POST /chat/channels/:id/messages`, `POST /chat/direct` |
| KVP | `GET/POST /kvp`, `PATCH /kvp/:id`, `POST /kvp/:id/photos` |
| Ressourcen | `GET /resources`, `POST/PATCH/DELETE /resources/:id` (Administrator), `GET /resources/bookings?from=&to=&resourceId=&mine=`, `POST /resources/availability`, `POST /resources/bookings` (mit `repeatWeeklyUntil`), `PATCH /resources/bookings/:id`, `POST /resources/bookings/:id/cancel|decide`, `GET /resources/bookings/review` |
| KI | `POST /ai/chat` |
| Suche | `GET /search?q=` |
| Protokoll | `GET /audit?projectId=` |
| System | `GET /health`, `GET /version`, `GET /changelog` |

Fehler kommen als `{ "error": "Meldung", "code": "…", "details": … }` mit passendem HTTP-Status zurück. Eine belegte Ressource liefert `409` mit `details.clashes` (Überschneidungen) und `details.alternatives` (freie Ressourcen gleicher Art).

### Echtzeit

WebSocket `wss://…/api/ws` (Cookie-Anmeldung). Nachrichten an den Server:

```json
{ "type": "subscribe", "channel": "project:<id>" }
```

Kanäle: `user:<id>` (automatisch), `project:<id>`, `chat:<id>`, `call:<id>`, `global`. Ereignisse z. B. `task.changed`, `cad.changed`, `files.changed`, `message.created`, `notification`, `presence`, `resources.changed` (Kanal `global`).

## Symbole

Die Oberfläche verwendet ausschließlich den eigenen SVG-Symbolsatz in `web/src/components/Icon.tsx` – keine Emojis. Ein automatischer Test (`server/test/no-emoji.test.ts`) schlägt fehl, sobald irgendwo im Quelltext ein Emoji steht.

```tsx
import { Icon, EntityIcon } from '../components/Icon';
<Icon name="calendar" />                       // einzelnes Symbol, übernimmt die Textfarbe
<EntityIcon value="factory:#4f46e5" size={20} /> // Projekt-/Team-Symbol mit Farbe
```

* Neues Symbol: im Objekt `P` in `Icon.tsx` einen Eintrag mit SVG-Pfaden (24 × 24, Strichstärke über `currentColor`) ergänzen.
* Projekte und Teams speichern ihr Symbol als `name` oder `name:#farbe`. Auswählbar sind die Namen in `PICKABLE_ICONS`.
* Die Datenbank-Migration `008_icons.sql` hat alte Emoji-Symbole in Namen übersetzt.

## Logo

Die Dateien liegen in `docs/brand/` (Bildmarke, Schriftzug hell/dunkel, PNG 512 px) und `web/public/` (Favicon, App-Symbol). Die Bildmarke zeigt einen Bogen – lateinisch *aperio*, „ich öffne“ – mit zwei versetzten Planungsbalken.

## Installation und Pförtner

* `install.sh` erzeugt `.env` und `deploy/Caddyfile` (beide nicht im Repository). Vorlage für alte Installationen: `deploy/Caddyfile.example`.
* Let's Encrypt über DNS: `deploy/compose.dns.yml` baut Caddy mit der Erweiterung `github.com/caddy-dns/<anbieter>` (`deploy/caddy/Dockerfile`); eingebunden über `COMPOSE_FILE` in `.env`.
* `uninstall.sh` entfernt alles, was `install.sh` angelegt hat.
* Ändern am Skript: `shellcheck install.sh uninstall.sh` muss ohne Warnung durchlaufen.

## Plugins (zusätzliche Werkzeuge)

Ein Plugin ist ein Ordner im Plugin-Verzeichnis (`data/plugins/<id>/`, im Docker-Betrieb automatisch eingebunden) mit einer `manifest.json`:

```json
{
  "id": "stueckzahlen",
  "name": "Stückzahlen-Planung",
  "version": "1.0.0",
  "description": "…",
  "projectTab": { "label": "Stückzahlen", "icon": "chart", "entry": "index.html" },
  "page": { "label": "Stückzahlen", "icon": "chart", "entry": "seite.html" }
}
```

* `id` muss dem Ordnernamen entsprechen.
* `icon` ist der Name eines Symbols aus dem AperioPlan-Symbolsatz (siehe „Symbole“).
* Der Administrator aktiviert Plugins unter **Einstellungen → Erweiterungen**.
* `projectTab` fügt jedem Projekt einen Reiter hinzu; die Seite wird mit `?projectId=…&projectNumber=…` aufgerufen.
* Plugins laufen unter derselben Adresse und nutzen die REST-API mit der Sitzung des angemeldeten Benutzers – sie sehen also genau das, was der Benutzer sehen darf.

Ein vollständiges Beispiel liegt in `docs/plugins/beispiel/`.

## Webhooks

Unter **Einstellungen → Erweiterungen → Webhooks** lassen sich Adressen eintragen, an die AperioPlan bei Ereignissen des Änderungsprotokolls eine POST-Anfrage sendet:

```json
{ "event": "cad.state", "at": "2026-10-27T13:00:00.000Z", "entityType": "cad_item", "entityId": "…",
  "projectId": "…", "summary": "0100-100-00-0000-00_Rahmen: Prüfung → Freigegeben", "user": { "id": "…", "name": "Max Mustermann" } }
```

* Ereignisfilter: `*` (alle), genaue Namen (`task.update`) oder Präfixe (`cad.*`).
* Header `X-Aperio-Signature` = HMAC-SHA256 des Rumpfs mit dem hinterlegten Geheimnis – zum Prüfen der Echtheit.

Typische Ereignisse: `project.create`, `task.create`, `task.update`, `cad.create`, `cad.checkin`, `cad.state`, `cad.revise`, `file.upload`, `absence.decide`, `kvp.create`, `kvp.status`.

## CAD-Wächter erweitern

Der API-Client in `cad-bridge/src/AperioPlan.Core` ist frei von externen Paketen und läuft unter .NET 4.8 und .NET 8. Er kann auch für Anbindungen anderer CAD-Systeme (Inventor, Creo …) verwendet werden – die Schnittstelle ist dieselbe wie für SolidWorks. Das Kommandozeilenwerkzeug `aperio-cad` zeigt alle Abläufe in kompakter Form.

## Mehrsprachigkeit

Deutsch ist die Ausgangssprache der Oberfläche. Weitere Sprachen sind einfache Sprachdateien in `web/src/i18n/` (Objekt „deutscher Text“ → Übersetzung) und werden in `web/src/i18n/index.tsx` unter `LANGUAGES` eingetragen. Fehlende Übersetzungen fallen auf Deutsch zurück.
