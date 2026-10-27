#!/usr/bin/env bash
# =====================================================================
#  AperioPlan – vollständig entfernen
#
#  Aufruf im Programmordner:   sudo ./uninstall.sh
#  Ohne Rückfragen (Vorsicht!): sudo ./uninstall.sh --ja
#
#  Entfernt: alle AperioPlan-Container, die Datenbank, Zertifikate,
#  Programmabbilder, den Programmordner mit Projektdateien und
#  Sicherungen sowie den Dienst für aperioplan.local.
#  Auf Wunsch vorher eine Abschlusssicherung, auf Wunsch auch Docker.
# =====================================================================
set -o pipefail

FORCE=false
[ "${1:-}" = "--ja" ] || [ "${1:-}" = "--yes" ] && FORCE=true

if [ -t 1 ]; then C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_INFO=$'\e[36m'; C_B=$'\e[1m'; C_0=$'\e[0m'; else C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""; C_B=""; C_0=""; fi
ok()   { echo "${C_OK}[✓]${C_0} $*"; }
info() { echo "${C_INFO}[i]${C_0} $*"; }
warn() { echo "${C_WARN}[!]${C_0} $*"; }
fail() { echo "${C_ERR}[x] $*${C_0}" >&2; exit 1; }

TTY=/dev/tty
{ : <"$TTY"; } 2>/dev/null || TTY=/dev/stdin
ask() { read -rp "$1" REPLY <"$TTY" || REPLY=""; REPLY="${REPLY:-${2:-}}"; }
yes_default() { [ "$FORCE" = true ] && return 0; ask "${C_INFO}[?]${C_0} $1 [J/n]: " "j"; [[ "$REPLY" =~ ^[JjYy] ]]; }
no_default()  { [ "$FORCE" = true ] && return 1; ask "${C_INFO}[?]${C_0} $1 [j/N]: " "n"; [[ "$REPLY" =~ ^[JjYy] ]]; }

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then exec sudo -E bash "$0" "$@"; fi
  fail "Bitte führen Sie das Skript als Root oder mit 'sudo ./uninstall.sh' aus."
fi

# ---------------------------------------------------------------- Programmordner finden
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && grep -q "name: aperioplan" "$SCRIPT_DIR/docker-compose.yml"; then
  DIR="$SCRIPT_DIR"
else
  ask "Wo ist AperioPlan installiert? [/opt/aperioplan]: " "/opt/aperioplan"; DIR="$REPLY"
fi
[ -f "$DIR/docker-compose.yml" ] || warn "In $DIR wurde keine AperioPlan-Installation gefunden – es werden nur Reste entfernt."
cd "$DIR" 2>/dev/null || cd /

get_env() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }
abs_path() { case "$1" in /*) echo "$1" ;; "") echo "" ;; *) echo "$DIR/${1#./}" ;; esac; }
FILES_PATH="$(abs_path "$(get_env FILES_PATH)")"
BACKUP_PATH="$(abs_path "$(get_env BACKUP_PATH)")"

COMPOSE=()
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); fi
fi
if [ -f "$DIR/.env" ]; then
  COMPOSE_FILE="$(get_env COMPOSE_FILE)"
  if [ -n "$COMPOSE_FILE" ]; then export COMPOSE_FILE; else unset COMPOSE_FILE; fi
fi

# ---------------------------------------------------------------- Übersicht
echo
echo "${C_B}============================================================${C_0}"
echo "${C_B}              AperioPlan vollständig entfernen              ${C_0}"
echo "${C_B}============================================================${C_0}"
cat <<EOF
Folgendes wird ${C_ERR}unwiderruflich gelöscht${C_0}:
  - alle AperioPlan-Dienste (Programm, Datenbank, Webserver, Wächter, Aktualisierung)
  - die Datenbank mit allen Projekten, Aufgaben, Zeiten und Benutzern
  - Zertifikate und Programmabbilder
  - der Programmordner $DIR
    (darin auch Projektdateien und Sicherungen, sofern sie dort liegen)
  - der Dienst für aperioplan.local
EOF
OUTSIDE=()
for p in "$FILES_PATH" "$BACKUP_PATH"; do
  [ -n "$p" ] && [ -d "$p" ] && [ "$p" != "/" ] && [[ "$p" != "$DIR"* ]] && OUTSIDE+=("$p")
done
if [ ${#OUTSIDE[@]} -gt 0 ]; then
  echo "Außerhalb des Programmordners (z. B. Netzlaufwerk) liegen außerdem:"
  for p in "${OUTSIDE[@]}"; do echo "    $p"; done
  echo "  Diese Ordner werden nur nach gesonderter Rückfrage gelöscht."
fi
echo

# ---------------------------------------------------------------- Abschlusssicherung
if [ -f "$DIR/docker-compose.yml" ] && [ ${#COMPOSE[@]} -gt 0 ] && yes_default "Vorher eine Abschlusssicherung (Datenbank und Dateien) anlegen?"; then
  TARGET="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"; TARGET="${TARGET:-/root}"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUT="$TARGET/aperioplan-abschluss-$STAMP"
  mkdir -p "$OUT"
  "${COMPOSE[@]}" up -d db >/dev/null 2>&1
  for _ in $(seq 1 20); do "${COMPOSE[@]}" exec -T db pg_isready -U aperio >/dev/null 2>&1 && break; sleep 2; done
  if "${COMPOSE[@]}" exec -T db pg_dump -U aperio aperio | gzip > "$OUT/datenbank.sql.gz" && [ -s "$OUT/datenbank.sql.gz" ]; then
    ok "Datenbank gesichert."
  else
    warn "Datenbank konnte nicht gesichert werden."
  fi
  [ -n "$FILES_PATH" ] && [ -d "$FILES_PATH" ] && tar -czf "$OUT/projektdateien.tar.gz" -C "$FILES_PATH" . && ok "Projektdateien gesichert."
  [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ] && tar -czf "$OUT/sicherungen.tar.gz" -C "$BACKUP_PATH" . && ok "Vorhandene Sicherungen übernommen."
  [ -f "$DIR/.env" ] && cp "$DIR/.env" "$OUT/einstellungen.env" && chmod 600 "$OUT/einstellungen.env"
  [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" 2>/dev/null
  ok "Abschlusssicherung liegt in: ${C_B}$OUT${C_0}"
fi

# ---------------------------------------------------------------- Bestätigung
if [ "$FORCE" != true ]; then
  echo
  ask "Zum Bestätigen bitte ${C_B}LÖSCHEN${C_0} eingeben: " ""
  [ "$REPLY" = "LÖSCHEN" ] || [ "$REPLY" = "LOESCHEN" ] || fail "Abgebrochen – es wurde nichts gelöscht."
fi

# ---------------------------------------------------------------- Dienste und Daten
if [ ${#COMPOSE[@]} -gt 0 ]; then
  if [ -f "$DIR/docker-compose.yml" ]; then
    info "Dienste werden beendet und mit allen Daten entfernt ..."
    "${COMPOSE[@]}" --profile office --profile video down --volumes --remove-orphans --rmi all >/dev/null 2>&1 || true
  fi
  # Reste, falls der Ordner bereits fehlt oder Container von Hand gestartet wurden
  ids="$(docker ps -aq --filter label=com.docker.compose.project=aperioplan)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  vols="$(docker volume ls -q --filter label=com.docker.compose.project=aperioplan)"
  [ -n "$vols" ] && docker volume rm -f $vols >/dev/null 2>&1
  docker network rm aperioplan_default >/dev/null 2>&1 || true
  for img in aperioplan:latest $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^aperioplan-caddy:'); do
    docker rmi -f "$img" >/dev/null 2>&1 || true
  done
  ok "Container, Datenbank, Zertifikate und Programmabbilder entfernt."
  if no_default "Auch die allgemeinen Hilfsabbilder (postgres, caddy, autoheal, docker-cli, collabora, coturn) löschen?"; then
    for img in postgres:16-alpine caddy:2-alpine caddy:2-builder willfarrell/autoheal:1.2.0 docker:27-cli collabora/code:latest coturn/coturn:latest; do
      docker rmi "$img" >/dev/null 2>&1 || true
    done
    docker builder prune -af >/dev/null 2>&1 || true
    ok "Hilfsabbilder entfernt (sofern sie nicht von anderen Programmen genutzt werden)."
  fi
fi

if systemctl list-unit-files 2>/dev/null | grep -q aperioplan-mdns; then
  systemctl disable --now aperioplan-mdns.service >/dev/null 2>&1
fi
rm -f /etc/systemd/system/aperioplan-mdns.service
rm -rf /usr/local/lib/aperioplan
systemctl daemon-reload >/dev/null 2>&1 || true
ok "Dienst für aperioplan.local entfernt."

for p in "${OUTSIDE[@]}"; do
  if no_default "Ordner außerhalb des Programmordners löschen: $p ?"; then
    rm -rf --one-file-system "$p" && ok "$p gelöscht."
  else
    info "$p bleibt erhalten."
  fi
done

# Sicherheitsprüfung: nur einen Ordner löschen, der wirklich AperioPlan enthält
if [ -d "$DIR" ] && [ "$DIR" != "/" ] && grep -qs "name: aperioplan" "$DIR/docker-compose.yml"; then
  cd /
  rm -rf --one-file-system "$DIR" && ok "Programmordner $DIR gelöscht."
elif [ -d "$DIR" ]; then
  warn "$DIR enthält keine AperioPlan-Installation und wurde deshalb nicht gelöscht."
fi

# ---------------------------------------------------------------- Docker (optional)
if command -v docker >/dev/null 2>&1 && no_default "Docker selbst ebenfalls deinstallieren? (Nur wenn kein anderes Programm Docker nutzt)"; then
  systemctl disable --now docker docker.socket containerd >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    docker-compose-plugin docker-ce-rootless-extras docker.io docker-compose >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -qq >/dev/null 2>&1 || true
  rm -rf /var/lib/docker /var/lib/containerd /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
  ok "Docker deinstalliert."
fi

echo
echo "${C_OK}AperioPlan wurde vollständig entfernt.${C_0}"
