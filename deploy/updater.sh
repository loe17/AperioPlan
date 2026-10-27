#!/bin/sh
# Wartet auf eine Aktualisierungsanfrage aus der Weboberfläche (Datei /update/request)
# und spielt den gewünschten Stand von GitHub ein. Nur das Programm wird neu gebaut –
# Datenbank, Dateien, Sicherungen und Einstellungen bleiben unberührt.
apk add --no-cache git >/dev/null 2>&1 || true
git config --global --add safe.directory "$PWD"
echo "Updater bereit"
while true; do
  if [ -f /update/request ]; then
    REF=$(cat /update/request | tr -d '[:space:]')
    rm -f /update/request
    [ -z "$REF" ] && REF=main
    echo "{\"status\":\"running\",\"ref\":\"$REF\",\"at\":\"$(date -Iseconds)\"}" > /update/status.json
    {
      echo "== Aktualisierung auf $REF gestartet $(date)"
      git fetch --tags origin && git checkout -q "$REF" && { git pull -q --ff-only origin "$REF" 2>/dev/null || true; } \
        && { [ -f deploy/Caddyfile ] || cp deploy/Caddyfile.example deploy/Caddyfile; } \
        && docker compose build app && docker compose up -d app
    } > /update/log.txt 2>&1
    if [ $? -eq 0 ]; then S=done; else S=failed; fi
    echo "{\"status\":\"$S\",\"ref\":\"$REF\",\"at\":\"$(date -Iseconds)\"}" > /update/status.json
  fi
  sleep 5
done
