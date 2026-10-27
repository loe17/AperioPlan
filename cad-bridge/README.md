# AperioPlan CAD-Wächter (SolidWorks)

Brücke zwischen dem Konstruktions-Arbeitsplatz und der Projektverwaltung (Kapitel 7 des Implementierungsplans).

| Projekt | Zweck | Ziel |
|---|---|---|
| `AperioPlan.Core` | API-Client, JSON, Einstellungen, Arbeitsbereich – ohne externe Pakete | .NET 4.8 + .NET 8 |
| `AperioPlan.SwAddin` | SolidWorks-Add-in: Speichermaske, Nummernvergabe, Eigenschaften, Zeichnung anlegen, Aus-/Einchecken, Versionsstand, Wo verbaut? | .NET 4.8 (x64) |
| `AperioPlan.ExportWorker` | Erzeugt bei Freigaben automatisch PDF, DXF und STEP | .NET 4.8 (x64) |
| `AperioPlan.Cli` | `aperio-cad` – dieselben Funktionen auf der Kommandozeile (Skripte, Tests, andere CAD-Systeme) | .NET 4.8 + .NET 8 |

## Bauen (Windows mit SolidWorks und Visual Studio 2022 / .NET SDK 8)

```bat
cd cad-bridge
dotnet build AperioPlan.CadBridge.sln -c Release
```

Liegt SolidWorks nicht unter `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS`, den Pfad zur API angeben:
`dotnet build -c Release /p:SolidWorksApiPath="D:\SOLIDWORKS\api\redist"`

## Installieren

1. In AperioPlan unter **Einstellungen → API-Schlüssel** einen Schlüssel „CAD-Wächter“ erzeugen.
2. `src\AperioPlan.SwAddin\bin\Release\net48\register.cmd` **als Administrator** ausführen.
3. SolidWorks starten → *Extras → Zusatzanwendungen* → „AperioPlan CAD-Wächter“ aktivieren (auch „Beim Start“).
4. Menü **AperioPlan → Einstellungen …**: Server-Adresse und API-Schlüssel eintragen, „Verbindung testen“.

## So arbeitet der Wächter

* **Speichern einer neuen Datei** → Speichermaske öffnet sich (Felder und Kataloge legt der Administrator im Web fest).
  Der Server vergibt die Nummer `0100-100-00-0000-00_Benennung`, der Wächter schreibt alle Eingaben als
  Custom Properties in die Datei und speichert sie im lokalen Arbeitsbereich
  (`%USERPROFILE%\AperioPlan\Arbeitsbereich\Projekte\0100_…\01_CAD`). Auf Wunsch wird die passende Zeichnung
  (`.slddrw`) mit gleicher Nummer und Firmenvorlage angelegt.
* **Strg + S auf einer nicht ausgecheckten Datei** → Hinweis „Gesperrt durch …“ bzw. Angebot zum Auschecken.
* **Freigegebene Stände** sind schreibgeschützt; Änderungen laufen über **Neuer Versionsstand** (00 → 01) mit Begründung.
* **Einchecken** lädt die Datei hoch; bei Baugruppen wird die Struktur (Stückliste) mit übertragen.
* **Wo verbaut?** zeigt vor Änderungen alle Baugruppen und Projekte, die das Teil verwenden.

## Export-Dienst

Auf einem Rechner mit SolidWorks-Lizenz (z. B. als geplante Aufgabe „bei Anmeldung“):

```bat
AperioPlan.ExportWorker.exe --formats pdf,dxf,step --interval 20
```

## Kommandozeile

```bat
aperio-cad config --server https://plan.firma.de --token ap_...
aperio-cad new --project 0100 --type part --sub 100 --name Rahmen --drawing --prop Werkstoff=S235JR --prop Beschaffung=Eigenfertigung --prop Gezeichnet="Max Mustermann"
aperio-cad checkout 0100-100-00-0000
aperio-cad checkin C:\...\0100-100-00-0000-00_Rahmen.sldprt -m "Bohrbild angepasst"
aperio-cad state 0100-100-00-0000 review
aperio-cad where-used 0100-100-00-0000
```
