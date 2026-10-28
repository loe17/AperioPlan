#!/usr/bin/env bash
# =====================================================================
#  AperioPlan – Installationsskript
#
#  Läuft auf Debian, Ubuntu, Raspberry Pi OS und verwandten Systemen
#  (eigener Rechner, Cloud-Server, virtuelle Maschine, Proxmox-LXC).
#
#  Aufruf im ausgecheckten Ordner:   sudo ./install.sh
#  oder direkt aus dem Internet:
#    curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/install.sh | sudo bash
#
#  Programmordner: /opt/aperioplan (anderer Ordner: curl ... | APERIO_DIR=/pfad bash)
#
#  Weiteren Speicherort (Netzlaufwerk, NAS, Windows-Freigabe) einrichten:
#    sudo ./install.sh speicherort
#
#  AperioPlan wird immer verschlüsselt (https) eingerichtet:
#   - öffentliche Domain         -> Let's-Encrypt-Zertifikat (automatisch)
#   - lokales Netz + eigene Domain -> Let's-Encrypt-Zertifikat über den DNS-Anbieter
#   - lokales Netz ohne Domain   -> eigenes AperioPlan-Zertifikat (einmal im Browser vertrauen)
# =====================================================================
set -o pipefail

# Das ganze Skript steht in einem Block: Bash liest es so vollständig ein, bevor es startet.
# Sonst könnten Befehle wie "docker compose exec" bei "curl ... | bash" den Rest des
# Skripts als Eingabe verschlucken – die Installation bräche dann ohne Meldung ab.
{

REPO_URL="${APERIO_REPO_URL:-https://github.com/loe17/AperioPlan.git}"
DEFAULT_DIR="/opt/aperioplan"

# ---------------------------------------------------------------- Ausgabe
if [ -t 1 ]; then
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_INFO=$'\e[36m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""; C_B=""; C_0=""
fi
ok()    { echo "${C_OK}[✓]${C_0} $*"; }
info()  { echo "${C_INFO}[i]${C_0} $*"; }
warn()  { echo "${C_WARN}[!]${C_0} $*"; }
fail()  { echo "${C_ERR}[x] $*${C_0}" >&2; exit 1; }
title() { echo; echo "${C_B}============================================================${C_0}"; printf "${C_B}%*s${C_0}\n" $(((60 + ${#1}) / 2)) "$1"; echo "${C_B}============================================================${C_0}"; }

# Eingaben immer vom Terminal lesen – funktioniert auch bei "curl ... | sudo bash"
TTY=/dev/tty
{ : <"$TTY"; } 2>/dev/null || TTY=/dev/stdin
ask() { # ask "Frage" Standardwert -> $REPLY
  local q="$1" def="${2:-}"
  read -rp "$q" REPLY <"$TTY" || REPLY=""
  REPLY="${REPLY:-$def}"
}
yes_default() { ask "${C_INFO}[?]${C_0} $1 [J/n]: " "j"; [[ "$REPLY" =~ ^[JjYy] ]]; }
no_default()  { ask "${C_INFO}[?]${C_0} $1 [j/N]: " "n"; [[ "$REPLY" =~ ^[JjYy] ]]; }

# ---------------------------------------------------------------- 2.1 Root
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "$0" ] && [ "$(basename "$0")" = "install.sh" ]; then
    info "Für die Installation werden Administratorrechte benötigt – starte erneut mit sudo ..."
    exec sudo -E bash "$0" "$@"
  fi
  fail "Bitte führen Sie das Skript als Root oder mit 'sudo ./install.sh' aus."
fi

title "AperioPlan – Installation"

# ---------------------------------------------------------------- 2.2 Betriebssystem
[ -r /etc/os-release ] || fail "Betriebssystem nicht erkannt (/etc/os-release fehlt)."
# shellcheck disable=SC1091
. /etc/os-release
if ! command -v apt-get >/dev/null 2>&1; then
  fail "Dieses System (${PRETTY_NAME:-unbekannt}) wird nicht unterstützt. Benötigt wird Debian, Ubuntu, Raspberry Pi OS oder ein verwandtes System mit apt-get."
fi
ok "Betriebssystem: ${PRETTY_NAME:-$ID}"

# ---------------------------------------------------------------- 2.3 Umgebung
VIRT="none"
if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT="$(systemd-detect-virt 2>/dev/null || echo none)"
elif [ -f /.dockerenv ]; then VIRT="docker"
elif grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then VIRT="lxc"
fi
case "$VIRT" in
  lxc|lxc-libvirt)
    warn "LXC-Container erkannt: Bitte stellen Sie sicher, dass in den Proxmox-/Host-Optionen 'Nesting' aktiviert ist, damit Docker lauffähig ist." ;;
  docker|podman)
    warn "Das Skript läuft selbst in einem Container ($VIRT). Docker-in-Docker wird nicht empfohlen." ;;
  none) ok "Umgebung: eigener Rechner" ;;
  *)    ok "Umgebung: virtuelle Maschine ($VIRT)" ;;
esac

# ---------------------------------------------------------------- 3. Abhängigkeiten
APT_UPDATED=false
apt_install() {
  if [ "$APT_UPDATED" = false ]; then
    info "Paketliste wird aktualisiert ..."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || fail "Paketliste konnte nicht aktualisiert werden."
    APT_UPDATED=true
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null || fail "Installation von '$*' fehlgeschlagen."
}

# check_and_install_dep <anzeigename> <prüfbefehl> <paket>
check_and_install_dep() {
  local name="$1" check="$2" pkg="$3"
  if eval "$check" >/dev/null 2>&1; then
    ok "$name ist bereits installiert."
    return
  fi
  if yes_default "'$name' fehlt. Jetzt automatisch über APT installieren?"; then
    apt_install "$pkg"
    ok "$name wurde installiert."
  else
    fail "'$name' wird für den Betrieb benötigt. Installation abgebrochen."
  fi
}

title "Systemprüfung"
check_and_install_dep "curl"            "command -v curl"                 curl
check_and_install_dep "git"             "command -v git"                  git
check_and_install_dep "ca-certificates" "dpkg -s ca-certificates"         ca-certificates
check_and_install_dep "openssl"         "command -v openssl"              openssl
check_and_install_dep "iproute2"        "command -v ip"                   iproute2

compose_ok() { docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; }
if command -v docker >/dev/null 2>&1 && compose_ok; then
  ok "docker ist bereits installiert."
  ok "docker compose ist bereits installiert."
else
  echo "${C_INFO}[?]${C_0} Docker / Docker Compose wurde nicht gefunden."
  if yes_default "    Soll das offizielle Docker-Installationsskript (https://get.docker.com) ausgeführt werden?"; then
    curl -fsSL https://get.docker.com | sh || fail "Docker konnte nicht installiert werden."
    ok "Docker wurde installiert."
  else
    fail "Docker wird für den Betrieb benötigt. Installation abgebrochen."
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || fail "Der Docker-Dienst läuft nicht. Bitte 'systemctl status docker' prüfen."
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && ! id -nG "$SUDO_USER" | grep -qw docker; then
  usermod -aG docker "$SUDO_USER" && info "Benutzer '$SUDO_USER' darf Docker jetzt ohne sudo nutzen (nach erneuter Anmeldung)."
fi
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else COMPOSE=(docker-compose); fi
dc() { "${COMPOSE[@]}" "$@" </dev/null; }

# ---------------------------------------------------------------- Programmordner
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && grep -q "name: aperioplan" "$SCRIPT_DIR/docker-compose.yml"; then
  APERIO_DIR="$SCRIPT_DIR"
else
  # Ohne Rückfrage nach /opt/aperioplan; anderer Ordner: APERIO_DIR=/pfad vor den Befehl schreiben
  APERIO_DIR="${APERIO_DIR:-$DEFAULT_DIR}"
  if [ -d "$APERIO_DIR/.git" ]; then
    info "Vorhandene Installation in $APERIO_DIR wird aktualisiert ..."
    git -C "$APERIO_DIR" pull -q --ff-only || warn "Aktualisierung von GitHub nicht möglich – vorhandener Stand wird verwendet."
  else
    mkdir -p "$(dirname "$APERIO_DIR")"
    git clone -q "$REPO_URL" "$APERIO_DIR" || fail "Herunterladen von $REPO_URL fehlgeschlagen."
  fi
fi
cd "$APERIO_DIR" || fail "Ordner $APERIO_DIR nicht erreichbar."
ok "Programmordner: $APERIO_DIR"

# ---------------------------------------------------------------- Zusatz: weiteren Speicherort einrichten
if [ "${1:-}" = "speicherort" ]; then
  title "Weiteren Speicherort einrichten"
  info "Ein Netzlaufwerk (NAS, Windows-Freigabe, NFS) oder ein Ordner auf diesem Server wird unter"
  info "$APERIO_DIR/data/locations/<Name> eingebunden. Danach steht er in AperioPlan unter"
  info "Einstellungen → Speicherorte zur Auswahl."
  ask "${C_INFO}[?]${C_0} Kurzer Name, z. B. nas-konstruktion oder archiv: " ""
  LOC="$(echo "$REPLY" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  [ -n "$LOC" ] || fail "Bitte einen Namen angeben."
  TARGET="$APERIO_DIR/data/locations/$LOC"
  mkdir -p "$TARGET"
  echo "  1) Windows-Freigabe oder NAS (SMB/CIFS), z. B. //nas01/projekte"
  echo "  2) NFS-Freigabe, z. B. nas01:/volume1/projekte"
  echo "  3) Ordner, der auf diesem Server schon vorhanden ist (z. B. zweite Festplatte)"
  ask "${C_INFO}[?]${C_0} Art [1]: " "1"
  KIND="$REPLY"
  SRC=""; OPTS=""; FSTYPE=""
  case "$KIND" in
    1)
      ask "${C_INFO}[?]${C_0} Adresse der Freigabe (//server/freigabe): " ""; SRC="$(echo "$REPLY" | sed 's|\\|/|g')"
      [[ "$SRC" == //* ]] || SRC="//$SRC"
      ask "${C_INFO}[?]${C_0} Benutzername: " ""; SMB_USER="$REPLY"
      read -rsp "${C_INFO}[?]${C_0} Passwort: " SMB_PASS <"$TTY"; echo
      ask "${C_INFO}[?]${C_0} Domäne (leer lassen, wenn keine): " ""; SMB_DOM="$REPLY"
      CRED="/root/.aperio-speicherort-$LOC"
      FSTYPE=cifs
      OPTS="credentials=$CRED,iocharset=utf8,file_mode=0777,dir_mode=0777,noperm,_netdev,nofail"
      ;;
    2)
      ask "${C_INFO}[?]${C_0} Adresse der Freigabe (server:/pfad): " ""; SRC="$REPLY"
      FSTYPE=nfs; OPTS="_netdev,nofail"
      ;;
    3)
      ask "${C_INFO}[?]${C_0} Vorhandener Ordner (absoluter Pfad): " ""; SRC="$REPLY"
      [ -d "$SRC" ] || fail "Ordner $SRC gibt es nicht."
      FSTYPE=none; OPTS="bind,nofail"
      ;;
    *) fail "Unbekannte Auswahl." ;;
  esac
  if [[ "$VIRT" == lxc* ]] && [ "$FSTYPE" != none ]; then
    # Unprivilegierte Proxmox-Container dürfen Netzlaufwerke nicht selbst einbinden
    warn "Dieser Server ist ein Proxmox-Container (LXC). Netzlaufwerke werden dort auf dem Proxmox-Host eingebunden"
    warn "und an den Container durchgereicht. Bitte auf dem Proxmox-Host (Shell des Knotens) ausführen:"
    echo
    echo "  mkdir -p /mnt/aperio-$LOC"
    if [ "$FSTYPE" = cifs ]; then
      echo "  printf 'username=%s\npassword=%s\n%s' '$SMB_USER' 'IHR-PASSWORT' '${SMB_DOM:+domain=$SMB_DOM}' > /root/.aperio-speicherort-$LOC && chmod 600 /root/.aperio-speicherort-$LOC"
      echo "  echo '$SRC /mnt/aperio-$LOC cifs credentials=/root/.aperio-speicherort-$LOC,iocharset=utf8,file_mode=0777,dir_mode=0777,noperm,_netdev,nofail 0 0' >> /etc/fstab"
    else
      echo "  echo '$SRC /mnt/aperio-$LOC nfs _netdev,nofail 0 0' >> /etc/fstab"
    fi
    echo "  mount /mnt/aperio-$LOC"
    echo "  pct set <ID-DIESES-CONTAINERS> -mp<FREIE-NUMMER> /mnt/aperio-$LOC,mp=$TARGET"
    echo "  pct reboot <ID-DIESES-CONTAINERS>"
    echo
    info "Die ID steht in Proxmox links neben dem Containernamen; freie Nummer z. B. 0, wenn noch kein Einhängepunkt (mp0) existiert."
    info "Danach in AperioPlan unter Einstellungen → Speicherorte den Ordner „$LOC“ hinzufügen."
    exit 0
  fi
  if [ "$FSTYPE" = cifs ]; then
    apt_install cifs-utils >/dev/null 2>&1 || apt-get install -y -qq cifs-utils >/dev/null 2>&1
    printf 'username=%s\npassword=%s\n%s' "$SMB_USER" "$SMB_PASS" "${SMB_DOM:+domain=$SMB_DOM}" > "$CRED"; chmod 600 "$CRED"
  elif [ "$FSTYPE" = nfs ]; then
    apt_install nfs-common >/dev/null 2>&1 || apt-get install -y -qq nfs-common >/dev/null 2>&1
  fi
  sed -i "\| $TARGET |d" /etc/fstab
  echo "$SRC $TARGET $FSTYPE $OPTS 0 0" >> /etc/fstab
  systemctl daemon-reload >/dev/null 2>&1 || true
  if mount "$TARGET"; then
    if touch "$TARGET/.aperio-test" 2>/dev/null && rm -f "$TARGET/.aperio-test"; then ok "Speicherort eingebunden und beschreibbar: $TARGET"
    else warn "Eingebunden, aber nicht beschreibbar – bitte Rechte auf der Freigabe prüfen."; fi
    ok "Wird nach jedem Neustart automatisch eingebunden (/etc/fstab)."
    dc restart app >/dev/null 2>&1 || true
    info "Jetzt in AperioPlan unter Einstellungen → Speicherorte den Ordner „$LOC“ hinzufügen."
  else
    fail "Einbinden fehlgeschlagen. Adresse, Benutzer und Passwort prüfen (Eintrag in /etc/fstab ist vorhanden)."
  fi
  exit 0
fi

# ---------------------------------------------------------------- 5. .env
title "Konfiguration"
set_env() { # set_env SCHLÜSSEL WERT
  local k="$1" v="$2" esc
  esc=$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')
  if grep -q "^${k}=" .env 2>/dev/null; then sed -i "s|^${k}=.*|${k}=${esc}|" .env
  elif grep -q "^# *${k}=" .env 2>/dev/null; then sed -i "s|^# *${k}=.*|${k}=${esc}|" .env
  else echo "${k}=${v}" >> .env; fi
}
get_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }
rnd_hex() { openssl rand -hex "${1:-32}" 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c $(( ${1:-32} * 2 )); }

OLD_DB_PASSWORD=""; OLD_BACKUP_KEY=""
if [ -f .env ]; then
  OLD_DB_PASSWORD="$(get_env DB_PASSWORD)"; OLD_BACKUP_KEY="$(get_env BACKUP_KEY)"
  if no_default "Eine bestehende .env-Datei wurde gefunden. Überschreiben?"; then
    cp .env ".env.sicherung-$(date +%Y%m%d-%H%M%S)"
    cp .env.example .env
    info "Alte Datei gesichert. Datenbank-Passwort und Sicherungsschlüssel werden übernommen, damit vorhandene Daten lesbar bleiben."
  else
    info "Bestehende .env bleibt erhalten, fehlende Werte werden ergänzt."
  fi
else
  cp .env.example .env
fi
chmod 600 .env

DB_PASSWORD="${OLD_DB_PASSWORD}"
[ -z "$DB_PASSWORD" ] || [ "$DB_PASSWORD" = "bitte-aendern" ] && DB_PASSWORD="$(rnd_hex 24)"
BACKUP_KEY="${OLD_BACKUP_KEY}"
NEW_BACKUP_KEY=false
[ -z "$BACKUP_KEY" ] && { BACKUP_KEY="$(rnd_hex 32)"; NEW_BACKUP_KEY=true; }
set_env DB_PASSWORD "$DB_PASSWORD"
set_env BACKUP_KEY "$BACKUP_KEY"
set_env APERIO_DIR "$APERIO_DIR"
ok "Zugangsschlüssel sind gesetzt."

# ---------------------------------------------------------------- Ports
port_busy() { # belegt durch ein anderes Programm als AperioPlan?
  local p="$1"
  ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || return 1
  dc ps caddy 2>/dev/null | grep -q "0.0.0.0:$p->" && return 1
  return 0
}
HTTP_PORT=80; HTTPS_PORT=443
if port_busy 80 || port_busy 443; then
  warn "Port 80 oder 443 wird bereits von einem anderen Programm verwendet (z. B. einem anderen Webserver)."
  ask "    Anderen Port für http verwenden [8080]: " 8080; HTTP_PORT="$REPLY"
  ask "    Anderen Port für https verwenden [8443]: " 8443; HTTPS_PORT="$REPLY"
fi
set_env HTTP_PORT "$HTTP_PORT"
set_env HTTPS_PORT "$HTTPS_PORT"
URL_PORT=""; [ "$HTTPS_PORT" != "443" ] && URL_PORT=":$HTTPS_PORT"

# ---------------------------------------------------------------- 4. Erreichbarkeit
HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -z "$HOST_IP" ] && HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

clean_host() { echo "$1" | sed -E 's|^[a-zA-Z]+://||; s|/.*$||; s|:[0-9]+$||' | tr 'A-Z' 'a-z' | tr -d '[:space:]'; }
is_local_name() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ "$1" = "localhost" ] || [[ "$1" =~ \.(local|lan|intern|internal|home|fritz\.box)$ ]] || [[ ! "$1" == *.* ]]; }

title "Konfiguration der Erreichbarkeit"
cat <<EOF
Wie soll AperioPlan erreichbar sein? Die Verbindung ist in allen Fällen verschlüsselt (https).

  1) Lokales Netzwerk (aperioplan.local und Server-IP)
     -> eigenes AperioPlan-Zertifikat; jeder Rechner vertraut ihm einmalig
  2) Lokales Netzwerk mit eigener Domain (z. B. kostenlos über DuckDNS)
     -> echtes Let's-Encrypt-Zertifikat, keine Browser-Warnung, kein offener Port nötig
  3) Eigene Domain / Webadresse im Internet (z. B. plan.meinedomain.de)
     -> echtes Let's-Encrypt-Zertifikat, Port 80/443 muss erreichbar sein
EOF
ask "Auswahl [1-3] (Standard: 1): " 1
MODE="$REPLY"; [[ "$MODE" =~ ^[123]$ ]] || MODE=1

MDNS_ENABLED=false; CUSTOM_DOMAIN=""; DNS_PROVIDER=""; DNS_API_TOKEN=""; TLS_KIND=""

if [ "$MODE" = 1 ]; then
  TLS_KIND="internal"
  info "Server-IP: ${HOST_IP:-unbekannt}"
  if yes_default "Soll AperioPlan im lokalen Netz unter 'https://aperioplan.local' erreichbar sein?"; then
    check_and_install_dep "avahi-daemon" "command -v avahi-daemon" avahi-daemon
    check_and_install_dep "avahi-utils"  "command -v avahi-publish" avahi-utils
    systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
    if [ "$(hostname -s)" != "aperioplan" ] && [ -n "$HOST_IP" ]; then
      mkdir -p /usr/local/lib/aperioplan
      cat > /usr/local/lib/aperioplan/mdns.sh <<'MDNS'
#!/bin/sh
# Gibt den Namen aperioplan.local mit der aktuellen IP-Adresse dieses Servers im lokalen Netz bekannt.
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -z "$IP" ] && IP=$(hostname -I | awk '{print $1}')
exec /usr/bin/avahi-publish -a -R aperioplan.local "$IP"
MDNS
      chmod 755 /usr/local/lib/aperioplan/mdns.sh
      cat > /etc/systemd/system/aperioplan-mdns.service <<'EOF'
[Unit]
Description=AperioPlan: Name aperioplan.local im lokalen Netz bekanntgeben
After=avahi-daemon.service network-online.target
Requires=avahi-daemon.service

[Service]
ExecStart=/usr/local/lib/aperioplan/mdns.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload && systemctl enable --now aperioplan-mdns.service >/dev/null 2>&1
    fi
    MDNS_ENABLED=true
    ok "aperioplan.local wird im lokalen Netz bekanntgegeben."
  fi
  if [ "$MDNS_ENABLED" = true ]; then PRIMARY="aperioplan.local"; else PRIMARY="${HOST_IP:-localhost}"; fi
elif [ "$MODE" = 2 ]; then
  TLS_KIND="dns"
  cat <<EOF

Let's Encrypt prüft hier über Ihren DNS-Anbieter, dass Ihnen die Domain gehört.
Der Server muss dafür NICHT aus dem Internet erreichbar sein.

  1) DuckDNS (kostenlos: name.duckdns.org – Konto unter https://www.duckdns.org)
  2) Cloudflare
  3) Hetzner DNS
  4) IONOS
EOF
  ask "DNS-Anbieter [1-4] (Standard: 1): " 1
  case "$REPLY" in 2) DNS_PROVIDER=cloudflare ;; 3) DNS_PROVIDER=hetzner ;; 4) DNS_PROVIDER=ionos ;; *) DNS_PROVIDER=duckdns ;; esac
  while :; do
    if [ "$DNS_PROVIDER" = duckdns ]; then
      ask "Ihr DuckDNS-Name (der Teil vor .duckdns.org): " ""
      CUSTOM_DOMAIN="$(clean_host "$REPLY")"; CUSTOM_DOMAIN="${CUSTOM_DOMAIN%.duckdns.org}"
      [ -n "$CUSTOM_DOMAIN" ] && CUSTOM_DOMAIN="${CUSTOM_DOMAIN}.duckdns.org"
    else
      ask "Domain für AperioPlan (z. B. plan.meinedomain.de): " ""
      CUSTOM_DOMAIN="$(clean_host "$REPLY")"
    fi
    [[ -n "$CUSTOM_DOMAIN" && "$CUSTOM_DOMAIN" == *.* ]] && ! is_local_name "$CUSTOM_DOMAIN" && break
    warn "Bitte eine gültige Internet-Domain ohne Leerzeichen eingeben."
  done
  while [ -z "$DNS_API_TOKEN" ]; do
    ask "Zugangsschlüssel (API-Token) des DNS-Anbieters: " ""
    DNS_API_TOKEN="$(echo "$REPLY" | tr -d '[:space:]')"
  done
  if [ "$DNS_PROVIDER" = duckdns ] && [ -n "$HOST_IP" ]; then
    if curl -fsS "https://www.duckdns.org/update?domains=${CUSTOM_DOMAIN%.duckdns.org}&token=${DNS_API_TOKEN}&ip=${HOST_IP}" | grep -q OK; then
      ok "$CUSTOM_DOMAIN zeigt jetzt auf $HOST_IP."
    else
      warn "DuckDNS hat die Adresse nicht angenommen – bitte Name und Token prüfen."
    fi
  else
    info "Bitte beim DNS-Anbieter einen A-Eintrag anlegen: $CUSTOM_DOMAIN -> ${HOST_IP:-<Server-IP>}"
  fi
  info "Hinweis: Manche Router (z. B. FRITZ!Box) blockieren Domains, die auf interne Adressen zeigen."
  info "         Dann unter Heimnetz > Netzwerk > Netzwerkeinstellungen > DNS-Rebind-Schutz '$CUSTOM_DOMAIN' eintragen."
  PRIMARY="$CUSTOM_DOMAIN"
else
  TLS_KIND="acme"
  while :; do
    ask "Bitte die Domain eingeben (z. B. plan.meinedomain.de): " ""
    CUSTOM_DOMAIN="$(clean_host "$REPLY")"
    if [[ -n "$CUSTOM_DOMAIN" && "$CUSTOM_DOMAIN" == *.* ]] && ! is_local_name "$CUSTOM_DOMAIN"; then break; fi
    warn "Für Let's Encrypt wird eine öffentliche Domain benötigt (keine IP-Adresse, kein .local). Für das lokale Netz bitte Option 1 oder 2 wählen."
  done
  info "Hinweis: Bitte stellen Sie sicher, dass Port 80/443 auf Ihrem Router freigegeben ist"
  info "         oder ein Reverse Proxy (z. B. Nginx Proxy Manager, Traefik, Caddy) auf diesen Server verweist."
  [ "$HTTP_PORT" != 80 ] && warn "Let's Encrypt prüft über Port 80. Leiten Sie Port 80 im Router auf Port $HTTP_PORT dieses Servers weiter."
  PRIMARY="$CUSTOM_DOMAIN"
fi

# ---------------------------------------------------------------- 4.3 Caddyfile
mkdir -p ./deploy data/files data/backups data/plugins data/locations data/downloads
SUFFIX=""; [ "$HTTPS_PORT" != 443 ] && SUFFIX=":$HTTPS_PORT"
{
  cat <<EOF
# Vom Installationsskript erzeugt ($(date '+%d.%m.%Y %H:%M')). Neu erzeugen: sudo ./install.sh
{
	servers {
		timeouts {
			read_body 0
		}
	}
EOF
  [ "$TLS_KIND" = internal ] && printf '\tskip_install_trust\n\tdefault_sni %s\n' "${HOST_IP:-localhost}"
  [ "$TLS_KIND" = acme ] && printf '\temail admin@%s\n' "$CUSTOM_DOMAIN"
  cat <<'EOF'
}

(aperioplan) {
	encode zstd gzip
	request_body {
		max_size 10GB
	}
	@office path /browser/* /hosting/* /cool/* /lool/*
	handle @office {
		reverse_proxy office:9980
	}
	handle {
		reverse_proxy app:3000
	}
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}

EOF
  case "$TLS_KIND" in
    internal)
      NAMES="localhost"; [ -n "$HOST_IP" ] && NAMES="$HOST_IP, $NAMES"; [ "$MDNS_ENABLED" = true ] && NAMES="aperioplan.local, $NAMES"
      HTTPS_NAMES="$(echo "$NAMES" | sed 's/\([^, ][^,]*\)/https:\/\/\1/g')"
      HTTP_NAMES="$(echo "$NAMES" | sed 's/\([^, ][^,]*\)/http:\/\/\1/g')"
      cat <<EOF
# Lokales Netz: eigenes AperioPlan-Zertifikat
$HTTPS_NAMES {
	tls internal
	import aperioplan
}

# http leitet auf https um; das Stammzertifikat kann hier heruntergeladen werden
$HTTP_NAMES {
	handle /zertifikat.crt {
		root * /data/caddy/pki/authorities/local
		rewrite * /root.crt
		header Content-Type application/x-x509-ca-cert
		header Content-Disposition "attachment; filename=AperioPlan-Zertifikat.crt"
		file_server
	}
	handle {
		redir https://{host}${SUFFIX}{uri} 308
	}
}
EOF
      ;;
    dns)
      cat <<EOF
# Lokales Netz mit eigener Domain: Let's Encrypt über den DNS-Anbieter ($DNS_PROVIDER)
$CUSTOM_DOMAIN {
	tls {
		dns $DNS_PROVIDER {env.DNS_API_TOKEN}
	}
	import aperioplan
	header Strict-Transport-Security "max-age=31536000"
}
EOF
      [ -n "$HOST_IP" ] && cat <<EOF

# Aufruf über die IP-Adresse führt zur Domain
http://$HOST_IP, http://localhost {
	redir https://$CUSTOM_DOMAIN${SUFFIX}{uri} 308
}
EOF
      ;;
    acme)
      cat <<EOF
# Öffentliche Domain: Let's Encrypt (automatisch, Verlängerung ebenfalls automatisch)
$CUSTOM_DOMAIN {
	import aperioplan
	header Strict-Transport-Security "max-age=31536000"
}
EOF
      ;;
  esac
} > ./deploy/Caddyfile
ok "Webserver-Konfiguration ./deploy/Caddyfile erzeugt."

set_env DOMAIN "$PRIMARY"
set_env PUBLIC_URL "https://${PRIMARY}${URL_PORT}"
set_env TLS_MODE ""
if [ "$TLS_KIND" = dns ]; then
  set_env DNS_PROVIDER "$DNS_PROVIDER"
  set_env DNS_API_TOKEN "$DNS_API_TOKEN"
  set_env COMPOSE_FILE "docker-compose.yml:deploy/compose.dns.yml"
else
  sed -i '/^COMPOSE_FILE=/d; /^DNS_API_TOKEN=/d; /^DNS_PROVIDER=/d' .env
fi
ok "Adresse in .env eingetragen: https://${PRIMARY}${URL_PORT}"

# ---------------------------------------------------------------- 5.9 Office im Browser
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
OFFICE_NOW="$(get_env COMPOSE_PROFILES)"
OFFICE_Q="Office im Browser einrichten (Word, Excel, PowerPoint und OpenDocument direkt in AperioPlan bearbeiten, braucht ca. 2 GB Arbeitsspeicher)?"
OFFICE_YES=false
if [[ "$OFFICE_NOW" == *office* ]]; then yes_default "$OFFICE_Q" && OFFICE_YES=true
elif [ "$MEM_MB" -ge 3500 ]; then yes_default "$OFFICE_Q" && OFFICE_YES=true
else
  warn "Dieser Server hat ${MEM_MB} MB Arbeitsspeicher – für Office im Browser werden mindestens 4 GB empfohlen."
  no_default "$OFFICE_Q" && OFFICE_YES=true
fi
if [ "$OFFICE_YES" = true ]; then
  set_env COMPOSE_PROFILES office
  set_env OFFICE_URL "https://${PRIMARY}${URL_PORT}"
  set_env OFFICE_INTERNAL_URL "http://office:9980"
  set_env OFFICE_WOPI_URL "http://app:3000"
  set_env OFFICE_SERVER_NAME "${PRIMARY}${URL_PORT}"
  ok "Office im Browser wird mit eingerichtet (Collabora Online)."
else
  sed -i '/^COMPOSE_PROFILES=/d; /^OFFICE_URL=/d; /^OFFICE_INTERNAL_URL=/d; /^OFFICE_WOPI_URL=/d; /^OFFICE_SERVER_NAME=/d' .env
  info "Office im Browser bleibt aus (später: sudo ./install.sh erneut ausführen)."
fi

# ---------------------------------------------------------------- 6. Start
title "Start"
info "AperioPlan wird gebaut und gestartet. Beim ersten Mal dauert das einige Minuten ..."
COMPOSE_FILE="$(get_env COMPOSE_FILE)"
if [ -n "$COMPOSE_FILE" ]; then export COMPOSE_FILE; else unset COMPOSE_FILE; fi
COMPOSE_PROFILES="$(get_env COMPOSE_PROFILES)"
if [ -n "$COMPOSE_PROFILES" ]; then export COMPOSE_PROFILES; else unset COMPOSE_PROFILES; fi
if ! dc up -d --build; then
  fail "Start fehlgeschlagen. Details: ${COMPOSE[*]} logs"
fi
dc restart caddy >/dev/null 2>&1 || true
if ! CADDY_CHECK="$(dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
  warn "Die Webserver-Konfiguration ./deploy/Caddyfile ist fehlerhaft:"
  echo "$CADDY_CHECK" | tail -5
fi

info "Warte auf AperioPlan ..."
HEALTHY=false
for _ in $(seq 1 60); do
  if dc exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then HEALTHY=true; break; fi
  sleep 3
done
dc ps
if [ "$HEALTHY" != true ]; then
  warn "AperioPlan antwortet noch nicht. Bitte in einer Minute erneut prüfen: ${COMPOSE[*]} logs -f app"
else
  ok "AperioPlan läuft."
fi

# Selbsttest: antwortet AperioPlan wirklich über https – so, wie der Browser es aufruft?
https_ok() { curl -sk --max-time 5 --resolve "$1:${HTTPS_PORT}:127.0.0.1" "https://$1:${HTTPS_PORT}/api/health" 2>/dev/null | grep -q '"ok"'; }
WEB_OK=false
for _ in $(seq 1 20); do
  if https_ok "$PRIMARY"; then WEB_OK=true; break; fi
  sleep 3
done
if [ "$WEB_OK" = true ]; then
  ok "https://${PRIMARY}${URL_PORT} antwortet."
else
  warn "https://${PRIMARY}${URL_PORT} antwortet auf diesem Server noch nicht. Letzte Meldungen des Webservers:"
  dc logs --tail 25 caddy
  warn "Bitte diese Ausgabe und '${COMPOSE[*]} logs --tail 50 app' an den Support senden."
fi

CERT_FILE=""
if [ "$TLS_KIND" = internal ]; then
  sleep 3
  if dc cp caddy:/data/caddy/pki/authorities/local/root.crt ./data/AperioPlan-Zertifikat.crt >/dev/null 2>&1; then
    CERT_FILE="$APERIO_DIR/data/AperioPlan-Zertifikat.crt"
    ok "Stammzertifikat gespeichert: $CERT_FILE"
  fi
else
  info "Zertifikat wird bei Let's Encrypt angefordert ..."
  CERT_OK=false
  for _ in $(seq 1 40); do
    if dc logs caddy 2>/dev/null | grep -qi "certificate obtained successfully\|skipping certificate"; then CERT_OK=true; break; fi
    sleep 3
  done
  if [ "$CERT_OK" = true ]; then ok "Let's-Encrypt-Zertifikat erhalten."
  else warn "Zertifikat noch nicht bestätigt. Caddy versucht es selbständig weiter – Verlauf: ${COMPOSE[*]} logs -f caddy"; fi
fi

# ---------------------------------------------------------------- 7. Übersicht
echo
cat <<EOF
${C_OK}====================================================================${C_0}
${C_OK}               AperioPlan erfolgreich gestartet!                    ${C_0}
${C_OK}====================================================================${C_0}

Die Web-Oberfläche ist unter folgenden Adressen erreichbar:
EOF
if [ -n "$CUSTOM_DOMAIN" ]; then
  echo "  -> Über die konfigurierte Domain:"
  echo "     https://${CUSTOM_DOMAIN}${URL_PORT}"
  echo ""
fi
if [ "$MDNS_ENABLED" = true ]; then
  echo "  -> Im lokalen Netz (mDNS):"
  echo "     https://aperioplan.local${URL_PORT}"
  echo ""
fi
if [ "$TLS_KIND" = internal ] && [ -n "$HOST_IP" ]; then
  echo "  -> Über die Server-IP:"
  echo "     https://${HOST_IP}${URL_PORT}"
  echo ""
fi
echo "Erste Anmeldung:  Benutzer ${C_B}admin${C_0} / Passwort ${C_B}admin${C_0} (wird sofort geändert)"
if [ "$TLS_KIND" = internal ]; then
  HTTP_SUFFIX=""; [ "$HTTP_PORT" != 80 ] && HTTP_SUFFIX=":$HTTP_PORT"
  cat <<EOF

--------------------------------------------------------------------
Damit der Browser nicht warnt, einmal pro Rechner das AperioPlan-
Zertifikat als vertrauenswürdig hinzufügen:
  1. Herunterladen: http://${PRIMARY}${HTTP_SUFFIX}/zertifikat.crt
  2. Windows: Datei doppelklicken > Zertifikat installieren >
     "Lokaler Computer" > "Vertrauenswürdige Stammzertifizierungsstellen"
     macOS: Datei öffnen > Schlüsselbund "System" > "Immer vertrauen"
  3. Browser neu starten.
EOF
  [ -n "$CERT_FILE" ] && echo "  (Die Datei liegt auch hier: $CERT_FILE)"
fi
cat <<EOF
--------------------------------------------------------------------
EOF
if [ "$NEW_BACKUP_KEY" = true ]; then
cat <<EOF
WICHTIGER SICHERHEITSHINWEIS:
Dein generierter BACKUP_KEY lautet: ${C_B}${BACKUP_KEY}${C_0}
Bitte sichere diesen Schlüssel an einem sicheren Ort!
Ohne diesen Schlüssel können Sicherungen nicht wiederhergestellt werden.
--------------------------------------------------------------------
EOF
else
  echo "Der bisherige BACKUP_KEY wurde beibehalten (siehe $APERIO_DIR/.env)."
  echo "--------------------------------------------------------------------"
fi
cat <<EOF
Nützliche Befehle zur Verwaltung (im Ordner $APERIO_DIR):
- Container-Status prüfen: ${COMPOSE[*]} ps
- Live-Logs anzeigen:      ${COMPOSE[*]} logs -f
- Anwendung neu starten:   ${COMPOSE[*]} restart
- Anwendung stoppen:       ${COMPOSE[*]} down
- Adresse ändern:          sudo ./install.sh
- Speicherort hinzufügen:  sudo ./install.sh speicherort
- Vollständig entfernen:   sudo ./uninstall.sh
${C_OK}====================================================================${C_0}
EOF
exit 0
}
