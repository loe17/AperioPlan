# AperioPlan – Handbuch für Administratoren

Dieses Handbuch erklärt Schritt für Schritt, wie AperioPlan auf einem Server eingerichtet, abgesichert, gesichert und aktuell gehalten wird.

---

## 1. Voraussetzungen

| Was | Empfehlung |
|---|---|
| Rechner | Linux mit `apt` (Ubuntu 22.04/24.04, Debian 12/13, Raspberry Pi OS) – eigener Rechner, Cloud-Server, virtuelle Maschine oder Proxmox-LXC (mit „Nesting“) |
| Arbeitsspeicher | ab 2 GB (kleine Teams), 4–8 GB für Firmen mit vielen Nutzern |
| Festplatte | Projektdaten + Platz für Sicherungen; Sicherungen idealerweise auf einer zweiten Platte oder einem NAS |
| Netzwerk | feste IP-Adresse im lokalen Netz (im Router reservieren) oder ein DNS-Name, z. B. `plan.firma.de` |

## 2. Installation mit einem Befehl

```sh
curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/install.sh | bash
```

(als root; als normaler Benutzer `… | sudo bash`)

oder, wenn der Ordner schon heruntergeladen ist:

```sh
git clone https://github.com/loe17/AperioPlan.git /opt/aperioplan
cd /opt/aperioplan
sudo ./install.sh
```

Das Skript führt Schritt für Schritt durch die Einrichtung:

1. **Systemprüfung** – Administratorrechte, Betriebssystem, Art des Rechners. In einem Proxmox-LXC-Container erinnert es daran, „Nesting“ einzuschalten.
2. **Fehlende Programme** – `curl`, `git`, `ca-certificates` und Docker werden geprüft. Fehlt etwas, fragt das Skript, ob es installiert werden soll (`[J/n]`, Eingabetaste = Ja).
3. **Zugangsschlüssel** – Datenbank-Passwort und Sicherungsschlüssel (`BACKUP_KEY`) werden zufällig erzeugt und in `.env` gespeichert. Gibt es schon eine `.env`, bleibt sie auf Wunsch erhalten; Passwort und Schlüssel werden in jedem Fall übernommen, damit vorhandene Daten lesbar bleiben.
4. **Erreichbarkeit** – Auswahl, wie AperioPlan erreichbar sein soll (siehe Abschnitt 4). Die Verbindung ist **immer verschlüsselt**.
5. **Start** – alle Bausteine werden gebaut und gestartet, danach prüft das Skript, ob AperioPlan antwortet und das Zertifikat da ist.
6. **Übersicht** – am Ende stehen alle Adressen, der Erstzugang und der `BACKUP_KEY` in einem Kasten.

Danach im Browser die angezeigte Adresse öffnen und mit **admin / admin** anmelden. Das Passwort **muss** sofort geändert werden – vorher ist kein Zugriff möglich.

> **Wichtig:** Der `BACKUP_KEY` steht auch in `.env`. Ohne diesen Schlüssel lassen sich Sicherungen nicht wiederherstellen. Bitte ausdrucken oder im Passwort-Tresor ablegen.

Das Skript kann jederzeit erneut ausgeführt werden, z. B. um die Adresse zu ändern: `sudo ./install.sh`.

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

## 3a. App-Store: Werkzeuge ein- und ausschalten

Jedes Werkzeug ist eine **App**. Eine neue Installation startet bewusst schlank – nur mit **Chat** und **E-Mail**. Alles Weitere schaltet der Administrator unter **App-Store** (Seitenleiste bzw. `/apps`) mit einem Klick ein:

* **Installieren** legt die App für die ganze Firma an; sie erscheint in der Seitenleiste aller Benutzer, die das Werkzeug nutzen dürfen (Einstellungen → Benutzer bzw. Standard-Werkzeuge je Abteilung).
* **Entfernen** blendet die App aus. **Daten bleiben erhalten** und sind nach erneutem Installieren wieder da.
* Manche Apps bauen auf anderen auf (z. B. Wartungsverträge auf CRM, Terminbuchung auf Kalender). Der App-Store weist darauf hin und installiert die Voraussetzung mit.
* Wer von 0.1.x aktualisiert, behält alle bisher festen Werkzeuge (Kalender, Zeiterfassung, CAD-Bridge, CRM …) eingeschaltet.
* Eigene Erweiterungen lassen sich als ZIP hochladen (**Plugin hochladen**), siehe Entwickler-Handbuch.

| Bereich | Apps |
|---|---|
| Zusammenarbeit | Kalender, Schwarzes Brett, Formulare, Mindmaps |
| Kommunikation | Chat und Videoanrufe, Meetings (mit Gast-Link), Telefonie, E-Mail |
| Kunden & Verkauf | CRM, Kalkulation, Kundenanfragen, Wartungs- und Serviceverträge, Terminbuchung, Messen und Veranstaltungen, E-Signatur |
| Produktion & Service | Instandhaltung, Qualität, Fertigung, Service-Einsätze |
| Technik | CAD-Bridge, PCB-Bridge, 3D-Viewer, Änderungsmanagement |
| Lager & Material | Einkauf, Lager, Inventar, Ressourcen, Fuhrpark |
| Personal | Zeiterfassung, Urlaub, Lohnabrechnung, Spesen und Reisekosten, Einsatzplanung, Personal, Unterweisungen und Schulungen |
| Finanzen | Finanzbuchhaltung, Nachhaltigkeit |
| Wissen & Organisation | Notizen, Wissensdatenbank, KVP-Ideenbox, Freigaben, Auswertungen, Eigene Felder, KI-Assistent |

Was nach dem Installieren einzurichten ist, steht in [Abschnitt 13a](#13a-einrichtung-der-apps).

## 4. Erreichbarkeit und HTTPS-Zertifikat

AperioPlan wird immer über `https://` aufgerufen – im Internet genauso wie im lokalen Netz. `install.sh` bietet drei Wege an:

| Auswahl | Adresse | Zertifikat | Voraussetzung |
|---|---|---|---|
| **1 – Lokales Netzwerk** | `https://aperioplan.local` und `https://<Server-IP>` | eigenes AperioPlan-Zertifikat | keine |
| **2 – Lokales Netz mit eigener Domain** | z. B. `https://firma.duckdns.org` | echtes Let's-Encrypt-Zertifikat | Konto bei einem DNS-Anbieter (DuckDNS kostenlos, Cloudflare, Hetzner, IONOS) |
| **3 – Domain im Internet** | z. B. `https://plan.firma.de` | echtes Let's-Encrypt-Zertifikat | Port 80 und 443 aus dem Internet erreichbar |

**Warum nicht immer Let's Encrypt?** Let's Encrypt stellt Zertifikate nur für Namen aus, die im Internet eindeutig sind. Für `aperioplan.local` oder eine IP-Adresse wie `192.168.1.20` ist das technisch nicht möglich. Deshalb gibt es Weg 2: Eine eigene (auch kostenlose) Domain zeigt auf die interne Adresse, und Let's Encrypt prüft die Domain über den DNS-Anbieter statt über das Internet. Der Server muss dafür nicht aus dem Internet erreichbar sein.

### Weg 1: eigenes AperioPlan-Zertifikat

Der Pförtner (Caddy) erzeugt eine eigene kleine Zertifizierungsstelle. Damit der Browser nicht warnt, wird ihr Stammzertifikat **einmal pro Rechner** als vertrauenswürdig hinterlegt:

1. `http://aperioplan.local/zertifikat.crt` (oder `http://<Server-IP>/zertifikat.crt`) öffnen – die Datei wird heruntergeladen. Sie liegt außerdem unter `data/AperioPlan-Zertifikat.crt` im Programmordner.
2. **Windows:** Datei doppelklicken → „Zertifikat installieren“ → „Lokaler Computer“ → „Alle Zertifikate in folgendem Speicher speichern“ → „Vertrauenswürdige Stammzertifizierungsstellen“.
   **macOS:** Datei öffnen → Schlüsselbund „System“ → Zertifikat doppelklicken → „Immer vertrauen“.
   **Firmen:** per Gruppenrichtlinie an alle Arbeitsplätze verteilen.
3. Browser neu starten.

`aperioplan.local` wird über Bonjour/mDNS im Netz bekanntgegeben (Dienst `aperioplan-mdns`). Windows 10/11, macOS, iOS und Android verstehen das ohne Zusatzprogramme. Ändert sich die IP-Adresse des Servers, `sudo ./install.sh` erneut ausführen – am besten die IP im Router fest vergeben.

### Weg 2: Let's Encrypt im lokalen Netz

* **DuckDNS (kostenlos):** Auf duckdns.org anmelden, einen Namen anlegen (z. B. `musterfirma`) und den angezeigten Token kopieren. `install.sh` trägt die interne IP des Servers automatisch bei DuckDNS ein.
* **Cloudflare, Hetzner, IONOS:** Beim Anbieter einen API-Token mit Recht „DNS bearbeiten“ erstellen und einen A-Eintrag `plan.firma.de → <interne Server-IP>` anlegen.

Für diesen Weg baut das Skript einmalig einen Pförtner mit passender Erweiterung (`deploy/caddy/Dockerfile`, eingebunden über `COMPOSE_FILE` in `.env`). Manche Router blockieren Domains, die auf interne Adressen zeigen („DNS-Rebind-Schutz“). Bei der FRITZ!Box die Domain unter *Heimnetz → Netzwerk → Netzwerkeinstellungen → DNS-Rebind-Schutz* als Ausnahme eintragen.

### Weg 3: Domain im Internet

Beim Domain-Anbieter einen A-Eintrag auf die öffentliche IP setzen und im Router Port 80 und 443 an den Server weiterleiten (oder einen vorhandenen Reverse Proxy auf den Server zeigen lassen). Das Zertifikat wird automatisch geholt und vor Ablauf erneuert.

### Technischer Hintergrund

Die Datei `deploy/Caddyfile` wird von `install.sh` erzeugt und nicht mit hochgeladen. Wer sie von Hand ändert, startet danach den Pförtner neu: `docker compose restart caddy`. Sind Port 80/443 schon belegt, fragt das Skript nach anderen Ports (`HTTP_PORT`, `HTTPS_PORT` in `.env`).

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
* Nummernkreise der installierten Apps, z. B. Rechnungen `RE-{JJJJ}-{NNNN}`, Tickets `T{JJ}-{NNNNN}`, Anträge `FG-{JJ}-{NNNN}`, Unterschriftsvorgänge `ES-{JJ}-{NNNN}`. Platzhalter: `{JJJJ}`/`{JJ}` Jahr, `{NNNN}` laufende Nummer mit fester Stellenzahl. Rechnungsnummern werden lückenlos erst beim Festschreiben vergeben.

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

## 9a. Ressourcen (Räume, Fahrzeuge, Geräte)

**Einstellungen → Ressourcen → Ressource anlegen.** Für jede Ressource lassen sich festlegen:

* Name, Art (Raum, Fahrzeug, Gerät, Sonstiges), Ort, Plätze und Farbe,
* **Genehmigung nötig** – Buchungen gelten erst, wenn der Genehmiger (oder ein Administrator) zustimmt,
* **nur für bestimmte Teams** buchbar,
* **gesperrt**, z. B. während einer Reparatur – bestehende Buchungen bleiben sichtbar, neue sind nicht möglich.

Doppelbuchungen schließt die Datenbank selbst aus – auch wenn zwei Personen im selben Moment buchen. Kollegen sehen nur, *wer* eine Ressource belegt; den Anlass sehen nur die buchende Person, der Genehmiger und Administratoren. Eine Ressource mit zukünftigen Buchungen kann nicht gelöscht, aber gesperrt werden.

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

> **Von 0.1.x auf 0.2.0:** Die Aktualisierung richtet die Datenbank für alle neuen Apps ein. Bisher genutzte Werkzeuge bleiben eingeschaltet; die neuen Apps erscheinen im App-Store und werden erst nach dem Installieren sichtbar. Weitere Schritte sind nicht nötig.
>
> **Hinweis zu älteren Versionsnummern:** Frühere Testfassungen hießen 1.0 und 1.1. Sie entsprechen dem Stand 0.1.x; die Zählung beginnt seitdem bei 0.x, bis die erste offizielle Fassung 1.0.0 erscheint.

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

Danach erscheint bei Word-, Excel- und PowerPoint-Dateien ein Bearbeiten-Knopf zum gemeinsamen Bearbeiten im Browser.

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

## 13a. Einrichtung der Apps

Die meisten Apps funktionieren sofort. Wer zusätzlich zum Administrator verwalten darf, wird jeweils im Reiter **Einstellungen** der App eingetragen. Jeden Morgen laufen die **täglichen Aufgaben** aller installierten Apps (Erinnerungen, fällige Termine, Rechnungen aus Verträgen); im Protokoll des Servers steht, was erledigt wurde.

| App | Einrichten | Gut zu wissen |
|---|---|---|
| **Rechnungen (CRM)** | Einstellungen → Allgemein → Briefkopf: Firmenname, Anschrift, USt-IdNr. oder Steuernummer, Bankverbindung | Rechnungen entstehen als E-Rechnung (ZUGFeRD, für Behörden XRechnung). Festgeschriebene Rechnungen sind unveränderbar; Korrektur nur per Gutschrift/Storno. |
| **Finanzbuchhaltung** | Freigabegrenze und Freigeber für Eingangsrechnungen, Kontenrahmen (SKR 03 oder SKR 04) und DATEV-Berater-/Mandantennummer, Soll- oder Ist-Versteuerung | Kontoauszüge als CAMT (XML) oder CSV der gängigen Banken einlesen; Übergabe an den Steuerberater im DATEV-Format. Die Umsatzsteuer-Voranmeldung selbst wird weiter über ELSTER bzw. den Steuerberater abgegeben. |
| **Lohnabrechnung** | Lohnbuchhalter eintragen, Personalstammdaten (Steuerklasse, Krankenkasse, Beitragsgruppen) je Mitarbeiter | Lohnsteuer nach dem amtlichen Programmablaufplan 2026, Sozialversicherung mit Midi- und Minijob. Ergebnis: Lohnzettel, Lohnjournal, DATEV-Buchungen, SEPA-Datei. **Lohnsteueranmeldung und SV-Meldungen werden nicht übermittelt** – dafür bleibt ein zertifiziertes Programm oder der Steuerberater zuständig. Die Werte bitte in den ersten Monaten mit einer bestehenden Abrechnung vergleichen. |
| **Instandhaltung, Qualität, Fertigung, Änderungen** | Verantwortliche je App; Nummernkreise | Störungen lassen sich per QR-Code am Gerät (Inventar) melden. |
| **Service-Einsätze** | Stundensatz, Kilometerpauschale, E-Mail-Text | Bericht mit Unterschrift des Kunden als PDF, danach Rechnungsentwurf mit einem Klick. |
| **Kundenanfragen** | Reaktionszeiten je Priorität, Kategorien, Absender-Adresse | Öffentliches Formular unter `/support`; Kunden verfolgen ihr Ticket über einen persönlichen Link. |
| **Wartungsverträge** | Nummernkreis | Erzeugt fällige Rechnungen automatisch am Morgen und warnt vor Kündigungsfristen. |
| **Terminbuchung** | Terminarten mit Dauer, Puffer und Verfügbarkeit | Buchungsseite `/book/<name>` berücksichtigt Kalender und Abwesenheiten. |
| **Spesen** | Freigeber (sonst Teamleitung), Buchhaltung, Kilometergeld | Verpflegungspauschalen nach den Inlandssätzen; Auslandsreisen bitte als Beleg erfassen. |
| **Einsatzplanung** | Planer (zusätzlich Teamleitungen) | Mitarbeiter sehen nur veröffentlichte Schichten. |
| **Personal** | Personalverantwortliche, Löschfrist für Bewerbungen (üblich 6 Monate), Dokumentarten | Personalakten sehen nur Administratoren und Personalverantwortliche. Stellenanzeigen unter `/jobs/<link>`; Bewerbungen werden nach Absage automatisch gelöscht. |
| **Unterweisungen** | Schulungsverantwortliche | Fällige Unterweisungen erinnern 30 Tage vorher; Nachweis als Excel. |
| **Fuhrpark** | Fuhrparkverantwortliche, Intervall der Führerscheinkontrolle | Fahrtenbuch lückenlos und nachträglich nicht änderbar; geldwerter Vorteil nach 1-%-Regel (E-Auto 0,25 %, Plug-in-Hybrid 0,5 %) als Hinweis. |
| **Freigaben** | Antragsarten mit Feldern, Stufen und Wertgrenzen; Verwalter | Ohne Teamleitung genehmigen Administratoren. |
| **E-Signatur** | Erinnerung nach Tagen, Gültigkeit der Links | **Einfache elektronische Signatur:** gezeichnete Unterschrift, Zeitpunkt, IP-Adresse und SHA-256-Prüfsumme des Dokuments im Signaturprotokoll. Nicht ausreichend, wo das Gesetz Schriftform verlangt. Ohne eingerichteten E-Mail-Versand lassen sich die Links auch kopieren und selbst weitergeben. |
| **Auswertungen** | – | Jeder sieht nur Daten, die er auch im jeweiligen Werkzeug sehen darf (z. B. eigene Arbeitszeiten). Berichte für alle freigeben dürfen Administratoren. |
| **Eigene Felder** | Felder für Projekte, Kunden, Kontakte, Lagerartikel, Inventar, Tickets und Service-Einsätze | Erscheinen im Datensatz unter „Weitere Angaben“. |
| **Nachhaltigkeit** | Verantwortliche, Basisjahr und Minderungsziel | Emissionsfaktoren vorbelegt (Umweltbundesamt: Strommix 2024 353 g/kWh, Verkehrsmittel; BAFA/KfW-Merkblatt CO₂-Faktoren: Erdgas, Heizöl, Diesel, Benzin, Fernwärme). Bei Ökostrom den Faktor des Versorgers eintragen. Tankbelege aus dem Fuhrpark und Dienstfahrten aus den Spesen werden nachts übernommen. |

Öffentliche Seiten ohne Anmeldung – `/support`, `/book/…`, `/event/…`, `/jobs/…`, `/sign/…` – sind gegen massenhafte Anfragen begrenzt und funktionieren nur, solange die zugehörige App installiert ist. Damit Links in E-Mails stimmen, muss in der `.env` die Adresse `PUBLIC_URL` gesetzt sein (das Installationsskript erledigt das).

## 14. Änderungsprotokoll

**Einstellungen → Änderungsprotokoll** zeigt revisionssicher jede Änderung (Wer? Wann? Was?). Einträge können technisch nicht verändert oder gelöscht werden.

## 15. Fehlersuche

| Problem | Lösung |
|---|---|
| Seite nicht erreichbar | `docker compose ps` – laufen alle Dienste? `docker compose logs caddy` |
| Zertifikatswarnung | Bei Weg 1: AperioPlan-Zertifikat auf dem Rechner hinterlegen (Abschnitt 4) |
| Let's Encrypt klappt nicht | `docker compose logs caddy` – Domain zeigt auf den Server? Port 80 weitergeleitet (Weg 3)? Token richtig (Weg 2)? |
| `aperioplan.local` nicht gefunden | `systemctl status aperioplan-mdns`; im Gast-WLAN ist mDNS oft gesperrt – dann die IP-Adresse verwenden |
| Anmeldung mit richtigem Passwort „tut nichts“ | AperioPlan über `https://` aufrufen; die Anmeldeseite zeigt in diesem Fall einen Hinweis |
| „Bitte anmelden“ in Schleife | Uhrzeit des Servers prüfen; Browser-Cookies löschen |
| Admin-Passwort vergessen | `docker compose exec app node dist/index.js reset-admin` – danach wieder admin/admin mit Passwortzwang |
| Sicherung lässt sich nicht einspielen | Passwort prüfen (`BACKUP_KEY` in `.env` hat Vorrang vor dem Passwort in den Einstellungen) |

## 16. AperioPlan vollständig entfernen

AperioPlan lässt sich mit einem Befehl vollständig und **ohne Rückfragen** entfernen:

```sh
curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/uninstall.sh | bash
```

(Als normaler Benutzer statt als root: `… | sudo bash`.)

Das Skript

1. **findet die Installation selbst** – auch wenn sie in einem anderen Ordner liegt,
2. **legt automatisch eine Abschlusssicherung an** – Datenbank, Projektdateien, Sicherungen und Einstellungen im Ordner `aperioplan-abschluss-<Datum>` im Benutzerordner,
3. wartet 10 Sekunden (Abbrechen mit Strg + C),
4. **entfernt** alle AperioPlan-Dienste, die Datenbank, die Zertifikate, die Programmabbilder, den Dienst für `aperioplan.local` und den Programmordner.

Daten auf Netzlaufwerken und Docker selbst bleiben erhalten. Wer auch das entfernen möchte, hängt Schalter an:

| Schalter | Wirkung |
|---|---|
| `--ohne-sicherung` | keine Abschlusssicherung |
| `--mit-daten` | auch Projektdateien und Sicherungen auf Netzlaufwerken löschen |
| `--mit-docker` | Docker selbst ebenfalls deinstallieren |
| `--sofort` | ohne die 10 Sekunden Bedenkzeit |

Beispiel: `curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/uninstall.sh | bash -s -- --mit-docker --sofort`

