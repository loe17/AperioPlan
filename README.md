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

Der vollständige Plan steht in [IMPLEMENTIERUNGSPLAN.md](IMPLEMENTIERUNGSPLAN.md).
