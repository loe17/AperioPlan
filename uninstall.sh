#!/usr/bin/env bash
# =====================================================================
#  AperioPlan – vollständig und automatisch entfernen (ohne Rückfragen)
#
#  Als root:        bash uninstall.sh
#  Als Benutzer:    sudo bash uninstall.sh
#  Direkt aus dem Internet:
#    curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/uninstall.sh | bash
#
#  Das Skript findet alle AperioPlan-Installationen selbst, legt vorher
#  automatisch eine Abschlusssicherung an und entfernt danach Dienste,
#  Datenbank, Zertifikate, Programmabbilder, Programmordner und den
#  Dienst für aperioplan.local.
#
#  Zusätzliche Schalter (optional):
#    --ohne-sicherung   keine Abschlusssicherung anlegen
#    --mit-daten        auch Projektdateien/Sicherungen auf Netzlaufwerken löschen
#    --mit-docker       Docker selbst ebenfalls deinstallieren
#    --sofort           ohne die 10 Sekunden Bedenkzeit
# =====================================================================
set -o pipefail

# Ganzes Skript in einem Block, damit es auch bei "curl ... | bash" vollständig gelesen wird.
{
BACKUP=true; WITH_DATA=false; WITH_DOCKER=false; WAIT=10
for a in "$@"; do
  case "$a" in
    --ohne-sicherung) BACKUP=false ;;
    --mit-daten)      WITH_DATA=true ;;
    --mit-docker)     WITH_DOCKER=true ;;
    --sofort|--ja|--yes) WAIT=0 ;;
    *) echo "Unbekannter Schalter: $a"; exit 1 ;;
  esac
done

if [ -t 1 ]; then C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_INFO=$'\e[36m'; C_B=$'\e[1m'; C_0=$'\e[0m'; else C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""; C_B=""; C_0=""; fi
ok()   { echo "${C_OK}[✓]${C_0} $*"; }
info() { echo "${C_INFO}[i]${C_0} $*"; }
warn() { echo "${C_WARN}[!]${C_0} $*"; }
fail() { echo "${C_ERR}[x] $*${C_0}" >&2; exit 1; }

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then exec sudo -E bash "$0" "$@"; fi
  fail "Bitte als root ausführen (oder mit 'sudo bash uninstall.sh')."
fi

HAVE_DOCKER=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then HAVE_DOCKER=true; fi
if [ "$HAVE_DOCKER" = true ]; then
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(); fi
fi

# ---------------------------------------------------------------- Installationen finden
is_aperio_dir() { [ -n "$1" ] && [ "$1" != "/" ] && grep -qs "name: aperioplan" "$1/docker-compose.yml"; }
declare -A SEEN=()
DIRS=()
add_dir() { local d; d="$(cd "$1" 2>/dev/null && pwd -P)" || return; is_aperio_dir "$d" || return; [ -n "${SEEN[$d]:-}" ] && return; SEEN[$d]=1; DIRS+=("$d"); }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
add_dir "$SCRIPT_DIR"
add_dir "$PWD"
# 1. Ordner, aus dem die laufenden Container gestartet wurden (Docker merkt sich das)
if [ "$HAVE_DOCKER" = true ]; then
  while read -r d; do [ -n "$d" ] && add_dir "$d"; done < <(docker ps -a --filter label=com.docker.compose.project=aperioplan \
    --format '{{index .Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u)
fi
# 2. übliche Orte
for d in /opt/aperioplan /opt/AperioPlan /root/aperioplan /root/AperioPlan /home/*/aperioplan /home/*/AperioPlan /srv/aperioplan; do
  add_dir "$d"
done

echo
echo "${C_B}============================================================${C_0}"
echo "${C_B}              AperioPlan vollständig entfernen              ${C_0}"
echo "${C_B}============================================================${C_0}"
if [ ${#DIRS[@]} -gt 0 ]; then
  echo "Gefundene Installation(en):"
  for d in "${DIRS[@]}"; do echo "    $d"; done
else
  info "Kein Programmordner gefunden – es werden nur Dienste und Reste entfernt."
fi
echo "Entfernt werden: Dienste, Datenbank, Zertifikate, Programmabbilder, Programmordner, aperioplan.local."
[ "$BACKUP" = true ] && echo "Vorher wird automatisch eine Abschlusssicherung angelegt (abschalten: --ohne-sicherung)."
[ "$WITH_DOCKER" = true ] && echo "Docker selbst wird ebenfalls deinstalliert."
if [ "$WAIT" -gt 0 ]; then
  echo
  echo "${C_WARN}Start in $WAIT Sekunden – zum Abbrechen Strg + C drücken.${C_0}"
  sleep "$WAIT"
fi
echo

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET_HOME="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"; TARGET_HOME="${TARGET_HOME:-/root}"

abs_path() { case "$2" in /*) echo "$2" ;; "") echo "" ;; *) echo "$1/${2#./}" ;; esac; }
get_env() { grep -E "^$2=" "$1/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }

OUTSIDE=()
for DIR in "${DIRS[@]}"; do
  info "Bearbeite $DIR"
  FILES_PATH="$(abs_path "$DIR" "$(get_env "$DIR" FILES_PATH)")"
  BACKUP_PATH="$(abs_path "$DIR" "$(get_env "$DIR" BACKUP_PATH)")"
  CF="$(get_env "$DIR" COMPOSE_FILE)"
  dc() { ( cd "$DIR" && if [ -n "$CF" ]; then COMPOSE_FILE="$CF" "${COMPOSE[@]}" "$@"; else "${COMPOSE[@]}" "$@"; fi ) </dev/null; }

  # ---------------------------------------------- Abschlusssicherung
  if [ "$BACKUP" = true ]; then
    OUT="$TARGET_HOME/aperioplan-abschluss-$STAMP"
    [ ${#DIRS[@]} -gt 1 ] && OUT="$OUT-$(basename "$DIR")"
    mkdir -p "$OUT"
    if [ "$HAVE_DOCKER" = true ] && [ ${#COMPOSE[@]} -gt 0 ]; then
      dc up -d db >/dev/null 2>&1
      for _ in $(seq 1 20); do dc exec -T db pg_isready -U aperio >/dev/null 2>&1 && break; sleep 2; done
      if dc exec -T db pg_dump -U aperio aperio 2>/dev/null | gzip > "$OUT/datenbank.sql.gz" && [ "$(stat -c %s "$OUT/datenbank.sql.gz")" -gt 100 ]; then
        ok "Datenbank gesichert."
      else
        rm -f "$OUT/datenbank.sql.gz"; info "Keine Datenbank zum Sichern gefunden."
      fi
    fi
    [ -n "$FILES_PATH" ] && [ -d "$FILES_PATH" ] && [ -n "$(ls -A "$FILES_PATH" 2>/dev/null)" ] && tar -czf "$OUT/projektdateien.tar.gz" -C "$FILES_PATH" . && ok "Projektdateien gesichert."
    [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ] && [ -n "$(ls -A "$BACKUP_PATH" 2>/dev/null)" ] && tar -czf "$OUT/sicherungen.tar.gz" -C "$BACKUP_PATH" . && ok "Vorhandene Sicherungen übernommen."
    [ -f "$DIR/.env" ] && cp "$DIR/.env" "$OUT/einstellungen.env" && chmod 600 "$OUT/einstellungen.env"
    [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" 2>/dev/null
    if [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then ok "Abschlusssicherung: ${C_B}$OUT${C_0}"; else rmdir "$OUT"; fi
  fi

  # ---------------------------------------------- Dienste beenden
  if [ "$HAVE_DOCKER" = true ] && [ ${#COMPOSE[@]} -gt 0 ]; then
    dc --profile office --profile video down --volumes --remove-orphans --rmi all >/dev/null 2>&1 || true
  fi
  for p in "$FILES_PATH" "$BACKUP_PATH"; do
    [ -n "$p" ] && [ -d "$p" ] && [ "$p" != "/" ] && [[ "$p" != "$DIR"* ]] && OUTSIDE+=("$p")
  done
  cd /
  rm -rf --one-file-system "$DIR" && ok "Programmordner $DIR gelöscht."
done

# ---------------------------------------------------------------- Reste in Docker
if [ "$HAVE_DOCKER" = true ]; then
  ids="$(docker ps -aq --filter label=com.docker.compose.project=aperioplan)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  vols="$(docker volume ls -q --filter label=com.docker.compose.project=aperioplan)"
  [ -n "$vols" ] && docker volume rm -f $vols >/dev/null 2>&1
  for v in aperioplan_db aperioplan_update aperioplan_caddy_data aperioplan_caddy_config; do docker volume rm -f "$v" >/dev/null 2>&1; done
  docker network rm aperioplan_default >/dev/null 2>&1 || true
  for img in aperioplan:latest $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^aperioplan-caddy:') \
             postgres:16-alpine caddy:2-alpine caddy:2-builder willfarrell/autoheal:1.2.0 docker:27-cli collabora/code:latest coturn/coturn:latest; do
    docker rmi "$img" >/dev/null 2>&1 || true   # Hilfsabbilder nur, wenn kein anderes Programm sie nutzt
  done
  docker builder prune -af >/dev/null 2>&1 || true
  ok "Dienste, Datenbank, Zertifikate und Programmabbilder entfernt."
fi

# ---------------------------------------------------------------- aperioplan.local
systemctl disable --now aperioplan-mdns.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/aperioplan-mdns.service
rm -rf /usr/local/lib/aperioplan
systemctl daemon-reload >/dev/null 2>&1 || true
ok "Dienst für aperioplan.local entfernt."

# ---------------------------------------------------------------- Daten auf Netzlaufwerken
for p in "${OUTSIDE[@]}"; do
  if [ "$WITH_DATA" = true ]; then rm -rf --one-file-system "$p" && ok "$p gelöscht."
  else info "$p liegt außerhalb des Programmordners und bleibt erhalten (löschen mit --mit-daten)."; fi
done

# ---------------------------------------------------------------- Docker (nur auf Wunsch)
if [ "$WITH_DOCKER" = true ] && command -v docker >/dev/null 2>&1; then
  systemctl disable --now docker docker.socket containerd >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    docker-compose-plugin docker-ce-rootless-extras docker.io docker-compose >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -qq >/dev/null 2>&1 || true
  rm -rf /var/lib/docker /var/lib/containerd /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
  ok "Docker deinstalliert."
fi

echo
echo "${C_OK}AperioPlan wurde vollständig entfernt.${C_0}"
exit 0
}
