# AperioPlan

**Modulare Web-Projektverwaltung, CAD-Zentrale & Firmen-Plattform** – aus dem lateinischen *aperio* = offenlegen, klar sichtbar machen.

AperioPlan läuft auf sparsamen ARM-Minicomputern, auf Arbeitsplatzrechnern und vor allem auf Firmen-Servern im Produktivbetrieb.

| Bereich | Technik |
|---|---|
| Web-Oberfläche | TypeScript, React, Vite |
| Server | TypeScript, Node.js, Fastify |
| Datenbank | PostgreSQL |
| CAD-Wächter (SolidWorks) | C# / .NET |
| Bereitstellung | Docker Compose, Caddy (HTTPS), Autoheal |

## Schnellstart auf einem Server

```sh
git clone https://github.com/loe17/AperioPlan.git && cd AperioPlan
./install.sh
```

Danach im Browser `https://<ihre-adresse>` öffnen und mit **admin / admin** anmelden – das Passwort muss sofort geändert werden.

## Entwicklung

```sh
corepack enable
pnpm install
# PostgreSQL lokal: postgres://aperio:aperio@localhost:5432/aperio
pnpm dev            # Server :3000 und Web-Oberfläche :5173
pnpm test           # Tests (benötigt Datenbank aperio_test)
node e2e/testplan.mjs   # Browser-Test des Testplans (frische Instanz, Playwright)
```

## Aufbau

```
shared/      Gemeinsame Fachlogik (Nummerierung, Status, Versionsprotokoll)
server/      Zentrale Serverlogik (REST-API, Echtzeit, Sicherung, Planer)
web/         Web-Oberfläche
cad-bridge/  CAD-Wächter für SolidWorks (C#)
deploy/      Caddy, Updater
docs/        Handbücher
```

## Handbücher

* [Administrator-Handbuch](docs/ADMINISTRATOR.md) – Installation, HTTPS, NAS, LDAP, Sicherung, Aktualisierung
* [Anwender-Handbuch](docs/ANWENDER.md) – Projekte, Aufgaben, CAD, Zeiten, Urlaub, Chat
* [Entwickler-Handbuch](docs/ENTWICKLER.md) – REST-API, Echtzeit, Plugins, Webhooks
* [CAD-Wächter](cad-bridge/README.md) – SolidWorks-Add-in, Export-Dienst, Kommandozeile
* [Testplan und Ergebnisse](docs/TESTPLAN.md)

## Funktionsumfang

* Projekte mit automatischer Nummer (0100 / PRJ-2026-0042), Teilprojekten, Dokumentnummern und Ordnerstruktur
* Kanban, Aufgabenliste, Gantt mit Abhängigkeiten, Whiteboard, Abschlussbericht – je Projekt zuschaltbar
* CAD-Zentrale: Nummern 0100-100-00-0000-00, Speichermaske, Aus-/Einchecken, Versionsstände, Wo verbaut?, Stücklisten, Freigabe-Workflow mit PDF/DXF/STEP
* Dateiverwaltung mit Versionen, NAS-Anbindung, Scan-Assistent, Gast-/Teilen-/Anforderungslinks
* Stempeluhr, Korrekturanfragen, Urlaubskonto, DSGVO-sauberer Teamkalender
* Chat, Videoanrufe mit Bildschirmfreigabe, E-Mail-Verwaltung, Office im Browser, KVP-Ideenbox
* KI-Anbindung, verschlüsselte Nacht-Sicherung mit Duplikaterkennung, Ein-Klick-Aktualisierung
* Deutsch und Englisch, Hell- und Dunkelmodus, Strg + K-Blitzsuche, Plugins und Webhooks

