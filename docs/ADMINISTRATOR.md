# AperioPlan – Handbuch für Administratoren

Dieses Handbuch erklärt Schritt für Schritt, wie AperioPlan auf einem Server eingerichtet, abgesichert, gesichert und aktuell gehalten wird.

---

## 1. Voraussetzungen

| Was | Empfehlung |
|---|---|
| Rechner | Linux-Server (Ubuntu 22.04/24.04, Debian 12), ARM-Minicomputer (z. B. Raspberry Pi 5) oder virtuelle Maschine |
| Arbeitsspeicher | ab 2 GB (kleine Teams), 4–8 GB für Firmen mit vielen Nutzern |
| Festplatte | Projektdaten + Platz für Sicherungen; Sicherungen idealerweise auf einer zweiten Platte oder einem NAS |
| Netzwerk | feste Adresse oder DNS-Name, z. B. `plan.firma.de`; für Internet-Zertifikate Port 80/443 erreichbar |

## 2. Installation mit einem Befehl

```sh
git clone https://github.com/loe17/AperioPlan.git
cd AperioPlan
./install.sh
```

Das Skript

1. installiert Docker, falls es fehlt,
2. legt die Datei `.env` mit zufälligen Passwörtern an und fragt nach der Adresse des Servers,
3. startet alle Bausteine: Programm, Datenbank, HTTPS-Pförtner, Wächterdienst und Updater.

Danach im Browser `https://<adresse>` öffnen und mit **admin / admin** anmelden. Das Passwort **muss** sofort geändert werden – vorher ist kein Zugriff möglich.

> **Wichtig:** In der `.env` steht `BACKUP_KEY`. Ohne diesen Schlüssel lassen sich Sicherungen nicht wiederherstellen. Bitte ausdrucken oder im Passwort-Tresor ablegen.

### Später wieder starten / stoppen

```sh
docker compose up -d      # starten
docker compose down       # stoppen (Daten bleiben erhalten)
docker compose logs -f app
```

## 3. Die Bausteine

| Dienst | Aufgabe |
|---|---|
| `app` | AperioPlan selbst (Oberfläche und Server) |
| `db` | PostgreSQL-Datenbank – verlustsicher, auch bei Stromausfall |
| `caddy` | „Digitaler Pförtner“: sorgt automatisch für HTTPS (grünes Schloss) |
| `autoheal` | Wächterdienst: startet Dienste neu, deren Gesundheitsprüfung fehlschlägt |
| `updater` | führt Aktualisierungen aus, die in der Oberfläche angestoßen werden |
| `office` *(optional)* | Collabora Online für Word/Excel/PowerPoint im Browser |
| `turn` *(optional)* | Vermittlungsserver für Videoanrufe über Netzgrenzen hinweg |

Alle Dienste laufen getrennt voneinander und beeinflussen keine anderen Programme auf dem Server.

## 4. HTTPS-Zertifikat

* **Öffentlich erreichbarer Server:** `DOMAIN=plan.firma.de` in der `.env` – Caddy holt automatisch ein kostenloses Let's-Encrypt-Zertifikat und erneuert es selbstständig.
* **Nur im Firmennetz:** zusätzlich `TLS_MODE=tls internal`. Caddy erzeugt dann ein firmeneigenes Zertifikat. Damit Browser nicht warnen, das Stammzertifikat einmalig auf den Arbeitsplätzen hinterlegen:
  `docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > firmen-ca.crt` und per Gruppenrichtlinie verteilen.

## 5. Speicherorte: lokal oder Netzlaufwerk (NAS)

In der `.env`:

```ini
FILES_PATH=./data/files      # Projektdateien
BACKUP_PATH=./data/backups   # Nacht-Tresor
```

**Netzlaufwerk einbinden** (Beispiel Windows-Freigabe / NAS per SMB):

```sh
sudo apt install cifs-utils
sudo mkdir -p /mnt/nas/projekte
echo "//nas01/projekte /mnt/nas/projekte cifs credentials=/root/.nas,uid=1000,gid=1000,iocharset=utf8,vers=3.0 0 0" | sudo tee -a /etc/fstab
sudo mount -a
```

Dann `FILES_PATH=/mnt/nas/projekte` setzen und `docker compose up -d` ausführen. Unter **Einstellungen → Speicherorte** zusätzlich den Pfad für den Windows-Explorer eintragen (z. B. `\\nas01\projekte`). Er wird bei jedem Projekt angezeigt.

Dateien, die Mitarbeiter direkt im Windows-Explorer in Projektordner legen, erscheinen automatisch in AperioPlan.

### Bestandsordner einlesen (Scan-Assistent)

**Einstellungen → Speicherorte → Bestandsordner einlesen**: Der Assistent zeigt alle Ordner der Ablage. Nicht zugeordnete Ordner können mit einem Klick als Projekt übernommen werden. Dabei

* wird eine Projektnummer vorgeschlagen (aus dem Ordnernamen) oder neu vergeben,
* kann der Ordner normgerecht umbenannt werden (`4711 Alte Presse` → `4711_Alte_Presse`),
* werden fehlende Standardordner (`01_CAD`, `02_Zeichnungen`, …) ergänzt,
* werden alle vorhandenen Dateien in die Projektverwaltung aufgenommen.

## 6. Benutzer, Teams und Rollen

| Rolle | Darf |
|---|---|
| Administrator | alles, inkl. Einstellungen, Sicherungen, Aktualisierungen |
| Teamleitung | Zeitkorrekturen und Urlaube seines Teams genehmigen, CAD-Freigaben erteilen, KVP-Ideen entscheiden |
| Mitarbeiter | in Projekten arbeiten, Zeiten stempeln, Urlaub beantragen |
| Gast | nur Projekte, in die er ausdrücklich eingeladen wurde (nur lesen) |

* **Einstellungen → Benutzer:** neue Konten mit Startpasswort anlegen. Der Mitarbeiter muss das Passwort bei der ersten Anmeldung ändern.
* **Einstellungen → Teams:** Abteilungen anlegen, Mitglieder zuordnen und die **Teamleitung** markieren. Die Teamleitung genehmigt Urlaube und Zeitkorrekturen ihres Teams.

### Firmen-Login (Active Directory / LDAP)

**Einstellungen → Firmen-Login:** Server (z. B. `ldaps://dc01.firma.local:636`), Basis-DN, Dienstkonto und Suchfilter eintragen, „Verbindung testen“. Mitarbeiter melden sich danach mit ihren Windows-Zugangsdaten an; beim ersten Login entsteht automatisch ein Konto. Über Gruppen kann festgelegt werden, wer Administrator oder Teamleitung wird.

## 7. Nummernkreise und Standard-Werkzeuge

**Einstellungen → Allgemein & Nummern**

* Projektnummern fortlaufend (`0100`, `0200` …) oder mit Jahreszahl (`PRJ-2026-0042`).
* Teilprojekte erhalten automatisch Buchstaben (`0100-A`, `0100-B`), Dokumente laufende Nummern (`0100-DOK-001`).
* Welche Werkzeuge (Kanban, Gantt, Whiteboard, CAD …) bei neuen Projekten sofort aktiv sind.

## 8. CAD-Zentrale und Speichermaske

**Einstellungen → Speichermaske (CAD)**

* Felder der Maske festlegen: Bezeichnung, Typ (Text, Auswahlliste, Zahl, Ja/Nein), Pflichtfeld, für Teile/Baugruppen/Zeichnungen.
* Die **Eigenschaft (SolidWorks)** ist der Name der Custom Property, die der CAD-Wächter in die Datei schreibt. In der Zeichnungsvorlage per `$PRPSHEET:"Werkstoff"` verknüpfen – dann erscheint der Wert automatisch im Schriftkopf.
* Dropdown-Kataloge pflegen (Werkstoffe, Oberflächen, DIN-Normen …).
* Nummernbereiche der Unterbaugruppen (100 Gestell, 200 Antrieb, 300 Pneumatik …).
* Name der Zeichnungsvorlage, die bei „Zeichnung anlegen“ verwendet wird.

Die Installation des CAD-Wächters auf den Konstruktions-PCs ist in `cad-bridge/README.md` beschrieben.

**Export-Dienst:** Damit bei Freigaben automatisch PDF, DXF und STEP entstehen, muss auf einem Windows-Rechner mit SolidWorks `AperioPlan.ExportWorker.exe` laufen (z. B. als geplante Aufgabe „bei Anmeldung“). Offene Aufträge sieht man unter **CAD-Zentrale → Fertigungsableitungen**.

## 9. Zeiterfassung, Urlaub, Feiertage

* **Einstellungen → Allgemein:** Rundung der Stempelzeiten.
* **Einstellungen → Feiertage:** Bundesland wählen und „Gesetzliche Feiertage übernehmen“ – für jedes neue Jahr einmal (die nächsten zwei Jahre werden beim Start automatisch angelegt). Betriebsurlaub kann zusätzlich eingetragen werden.
* Urlaubsanspruch je Mitarbeiter unter **Benutzer**; dort lassen sich auch Resturlaub aus dem Vorjahr oder Sonderurlaub buchen („Urlaubskonto korrigieren“).
* **Datenschutz:** Im Teamkalender sehen Kollegen ausschließlich, *wer wann abwesend* ist – nie die Art der Abwesenheit oder Notizen. Diese sehen nur der Mitarbeiter selbst und seine Teamleitung.

## 10. Nacht-Tresor (Sicherung) und Wiederherstellung

**Einstellungen → Sicherung**

* Jede Nacht (Standard 02:00 Uhr) wird eine verschlüsselte Sicherung (`.apb`) aller Daten und Dateien erstellt. Die letzten 14 werden aufbewahrt.
* „Jetzt sichern“ erstellt sofort eine Sicherung; jede Sicherung kann heruntergeladen werden.
* **Einspielen:** „Einspielen …“ bei einer vorhandenen Sicherung oder „Sicherung hochladen“. AperioPlan prüft zuerst und zeigt:
  * was neu ist, was identisch ist,
  * welche Einträge in beiden Ständen vorhanden, aber **unterschiedlich** sind – mit Datum beider Stände.
  Standard ist „neuerer Stand gewinnt“; für jeden Eintrag kann einzeln „Bestand“ oder „Sicherung“ gewählt werden.

**Komplette Wiederherstellung auf neuem Server:** AperioPlan neu installieren, mit admin/admin anmelden, Passwort ändern, Sicherung hochladen, Strategie „Immer Sicherung übernehmen“ wählen.

## 11. Aktualisierung

**Einstellungen → Aktualisierung → Prüfen.** Ist eine neue Version auf GitHub verfügbar, genügt ein Klick auf „Jetzt aktualisieren“. AperioPlan

1. erstellt vorher automatisch eine Sicherung,
2. lädt den neuen Programmstand von GitHub,
3. baut nur das Programm neu und startet es.

Datenbank, Dateien, Sicherungen und Einstellungen bleiben unberührt. Die Versionsnummer steht unten links; ein Klick darauf zeigt „Was ist neu?“.

Manuell geht es auch: `git pull && docker compose up -d --build app`.

## 12. Ausfallsicherheit

* Alle Dienste starten nach einem Absturz oder Neustart des Servers selbstständig (`restart: unless-stopped`).
* Der Wächterdienst prüft alle 15 Sekunden die Gesundheit von Programm und Datenbank und startet einen hängenden Dienst neu.
* Gesundheitsprüfung von außen (z. B. für ein Monitoring): `https://<adresse>/api/health`.

## 13. Optionale Erweiterungen

### Büro-Dokumente im Browser

```sh
# in .env:
OFFICE_URL=https://plan.firma.de
docker compose --profile office up -d
```

Danach erscheint bei Word-, Excel- und PowerPoint-Dateien ein 📝-Knopf zum gemeinsamen Bearbeiten im Browser.

### Videoanrufe über das Internet

Im Firmennetz funktionieren Videoanrufe ohne weitere Einrichtung. Für Teilnehmer außerhalb (Homeoffice, VPN mit NAT) einen TURN-Server starten:

```sh
# in .env:
TURN_URLS=turn:plan.firma.de:3478
TURN_PASSWORD=<zufälliges Passwort>
docker compose --profile video up -d
```

### E-Mail

**Einstellungen → E-Mail-Konto:** gemeinsames Projektpostfach (IMAP/SMTP) eintragen. E-Mails werden alle 5 Minuten abgerufen und anhand der Projektnummer im Betreff (z. B. `[0100]`) automatisch zugeordnet.

### KI-Anbindung

**Einstellungen → KI-Anbindung:** Für Datenschutz empfiehlt sich ein lokales Modell, z. B. Ollama auf einem eigenen Rechner (`http://ki-server:11434/v1`, Modell `llama3.1`). Alternativ externe Anbieter mit API-Schlüssel.

### Plugins und Webhooks

Siehe `docs/ENTWICKLER.md`.

## 14. Änderungsprotokoll

**Einstellungen → Änderungsprotokoll** zeigt revisionssicher jede Änderung (Wer? Wann? Was?). Einträge können technisch nicht verändert oder gelöscht werden.

## 15. Fehlersuche

| Problem | Lösung |
|---|---|
| Seite nicht erreichbar | `docker compose ps` – laufen alle Dienste? `docker compose logs caddy` |
| Zertifikatswarnung | Bei Intranet: Firmen-Stammzertifikat verteilen (Abschnitt 4) |
| „Bitte anmelden“ in Schleife | Uhrzeit des Servers prüfen; Browser-Cookies löschen |
| Admin-Passwort vergessen | `docker compose exec app node dist/index.js reset-admin` – danach wieder admin/admin mit Passwortzwang |
| Sicherung lässt sich nicht einspielen | Passwort prüfen (`BACKUP_KEY` in `.env` hat Vorrang vor dem Passwort in den Einstellungen) |
