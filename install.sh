#!/bin/sh
# Einrichtung auf einem Linux-Server (Ubuntu/Debian/Raspberry Pi OS) mit einem einzigen Befehl:
#   curl -fsSL https://raw.githubusercontent.com/loe17/AperioPlan/main/install.sh | sh
# oder im ausgecheckten Ordner:  ./install.sh
set -e
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker wird installiert ..."
  curl -fsSL https://get.docker.com | sh
fi
if [ ! -f docker-compose.yml ]; then
  git clone https://github.com/loe17/AperioPlan.git aperioplan && cd aperioplan
fi
if [ ! -f .env ]; then
  cp .env.example .env
  rnd() { head -c 24 /dev/urandom | base64 | tr -d '/+=' ; }
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(rnd)/" .env
  sed -i "s/^BACKUP_KEY=.*/BACKUP_KEY=$(rnd)/" .env
  printf "Unter welcher Adresse soll AperioPlan erreichbar sein? [localhost]: "
  read -r DOMAIN </dev/tty || DOMAIN=""
  sed -i "s/^DOMAIN=.*/DOMAIN=${DOMAIN:-localhost}/" .env
  case "${DOMAIN:-localhost}" in
    *.local|*.lan|*.intern|localhost|[0-9]*) sed -i "s/^TLS_MODE=.*/TLS_MODE=tls internal/" .env ;;
  esac
  echo "Konfiguration in .env angelegt. Den BACKUP_KEY bitte sicher aufbewahren – ohne ihn lassen sich Sicherungen nicht einspielen!"
fi
mkdir -p data/files data/backups
docker compose up -d --build
echo
echo "AperioPlan läuft. Erstzugang: Benutzer admin / Passwort admin (muss sofort geändert werden)."
