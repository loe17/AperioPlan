/**
 * Erzeugt die Einrichtungsdateien für die Wächter (CAD-Bridge mit SolidWorks, PCB-Bridge mit KiCad).
 * Das Paket enthält Serveradresse und Zugangsschlüssel – der Anwender muss nichts eintippen.
 */
export type BridgeKind = 'cad' | 'pcb';
export interface InstallerConfig { server: string; token: string; user: string; version: string; packages: Record<string, string> }

const BOM = '﻿';
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

const COMMON_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $here 'aperioplan-bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$auth = @{ Authorization = "Bearer $($cfg.token)" }
function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    $t" -ForegroundColor Green }
function Fail($t, $hint) {
  Write-Host ''; Write-Host "FEHLER: $t" -ForegroundColor Red
  if ($hint) { Write-Host "Lösung: $hint" -ForegroundColor Yellow }
  Read-Host 'Enter drücken zum Beenden' | Out-Null; exit 1
}
function Check-Server {
  Step "Verbindung zu $($cfg.server) prüfen"
  try { $h = Invoke-RestMethod -Uri "$($cfg.server)/api/health" -TimeoutSec 20 -UseBasicParsing }
  catch {
    $m = $_.Exception.Message
    if ($m -match 'SSL|TLS|Vertrauensstellung|trust|certificate|Zertifikat') {
      Fail 'Das Sicherheitszertifikat des Servers wird von diesem PC nicht anerkannt.' 'Das Stammzertifikat des AperioPlan-Servers auf diesem PC unter „Vertrauenswürdige Stammzertifizierungsstellen“ installieren (siehe Administrator-Handbuch, Abschnitt Zertifikate) und die Einrichtung erneut starten.'
    }
    if ($m -match 'remote name|Remotename|resolve|aufgelöst|No such host') {
      Fail "Der Server $($cfg.server) wurde im Netzwerk nicht gefunden." 'Ist der PC im Firmennetz oder per VPN verbunden? Stimmt die Adresse (Einstellungen → Allgemein → Öffentliche Adresse)?'
    }
    Fail "Der Server antwortet nicht ($m)." 'Läuft AperioPlan? Lässt die Firewall die Verbindung (Port 443) zu?'
  }
  Ok "Server erreichbar (Version $($h.version))"
  try { $me = Invoke-RestMethod -Uri "$($cfg.server)/api/auth/me" -Headers $auth -UseBasicParsing } catch {
    Fail 'Der Zugangsschlüssel wurde nicht angenommen.' 'Bitte in AperioPlan ein neues Installationspaket herunterladen – der Schlüssel wurde vielleicht widerrufen.'
  }
  Ok "Angemeldet als $($me.displayName)"
}
function Get-Package($key, $target) {
  $url = $cfg.packages.$key
  if ($url -notmatch '^https?:') { $url = "$($cfg.server)$url" }
  $tmp = Join-Path $env:TEMP ("aperioplan-" + [guid]::NewGuid().ToString() + '.zip')
  try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers $auth }
  catch { Fail "Das Programmpaket konnte nicht geladen werden ($($_.Exception.Message))." 'Der Administrator legt die Pakete aus dem GitHub-Release in den Download-Ordner des Servers (siehe Administrator-Handbuch) – oder der PC braucht Internetzugang zu github.com.' }
  if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Expand-Archive -Path $tmp -DestinationPath $target -Force
  Remove-Item $tmp -Force
  Ok "Installiert nach $target"
}
function Write-Settings($file, $extra) {
  $dir = Join-Path $AppData 'AperioPlan'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir $file
  $s = @{}
  if (Test-Path $path) { try { (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json).psobject.Properties | ForEach-Object { $s[$_.Name] = $_.Value } } catch {} }
  $s.serverUrl = $cfg.server; $s.token = $cfg.token
  if (-not $s.workspace) { $s.workspace = Join-Path $UserProfile 'AperioPlan\Arbeitsbereich' }
  foreach ($k in $extra.Keys) { $s[$k] = $extra[$k] }
  [IO.File]::WriteAllText($path, ($s | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Ok "Einstellungen gespeichert ($path)"
}
function Send-Hello($kind, $appVersion) {
  $os = (Get-CimInstance Win32_OperatingSystem).Caption
  $body = @{ kind = $kind; host = $env:COMPUTERNAME; os = $os; version = $cfg.version; appVersion = $appVersion } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$($cfg.server)/api/bridge/hello" -Headers $auth -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -UseBasicParsing | Out-Null
}
`;

function cadPs1() {
  return String.raw`param([string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA, [string]$UserProfile = $env:USERPROFILE, [string]$UserName = "$env:USERDOMAIN\$env:USERNAME")
# AperioPlan CAD-Bridge – geführte Einrichtung (SolidWorks-Add-in, Export-Dienst, Kommandozeile)

# Das Add-in wird für alle Benutzer in SolidWorks angemeldet – dafür sind Administratorrechte nötig
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Für die Anmeldung in SolidWorks werden Administratorrechte benötigt …'
  $q = [char]34
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ($q + $MyInvocation.MyCommand.Path + $q), '-AppData', ($q + $AppData + $q), '-LocalAppData', ($q + $LocalAppData + $q), '-UserProfile', ($q + $UserProfile + $q), '-UserName', ($q + $UserName + $q))
  exit
}
${COMMON_PS}
Write-Host 'AperioPlan CAD-Bridge – Einrichtung' -ForegroundColor White
Check-Server

Step 'SolidWorks suchen'
$sw = Get-ChildItem 'HKLM:\SOFTWARE\SolidWorks' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^SOLIDWORKS \d{4}$' } | Sort-Object PSChildName -Descending | Select-Object -First 1
if (-not $sw) { Fail 'SolidWorks wurde auf diesem PC nicht gefunden.' 'Die CAD-Bridge wird auf Arbeitsplätzen mit installiertem SolidWorks eingerichtet. Für Leiterplatten gibt es die PCB-Bridge.' }
$swVersion = $sw.PSChildName
Ok "Gefunden: $swVersion"
if (Get-Process SLDWORKS -ErrorAction SilentlyContinue) { Write-Host '    SolidWorks läuft gerade – bitte nach der Einrichtung neu starten.' -ForegroundColor Yellow }

Step 'Programm laden'
$dest = Join-Path $LocalAppData 'AperioPlan\CAD-Bridge'
$regasm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'
$old = Join-Path $dest 'SwAddin\AperioPlan.SwAddin.dll'
if (Test-Path $old) { & $regasm /unregister $old | Out-Null }
Get-Package 'cad-win' $dest

Step 'Add-in in SolidWorks anmelden'
$dll = Join-Path $dest 'SwAddin\AperioPlan.SwAddin.dll'
if (-not (Test-Path $dll)) { Fail 'Im Programmpaket fehlt das SolidWorks-Add-in.' 'Bitte den Administrator fragen: Das Paket AperioPlan-CAD-Bridge-win-x64.zip muss mit SolidWorks-Schnittstelle gebaut sein (siehe cad-bridge/README.md).' }
& $regasm /codebase $dll | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Die Anmeldung des Add-ins ist fehlgeschlagen.' 'Ist .NET Framework 4.8 installiert? Läuft ein Virenscanner, der RegAsm blockiert?' }
New-Item -Force -Path 'HKCU:\Software\SolidWorks\AddInsStartup\{b581e74a-99d2-4a1e-836f-49f20c1a8b92}' | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\SolidWorks\AddInsStartup\{b581e74a-99d2-4a1e-836f-49f20c1a8b92}' -Name '(default)' -Value 1
Ok 'Add-in angemeldet (startet mit SolidWorks)'

Write-Settings 'cad-bridge.json' @{}

Step 'Export-Dienst'
Write-Host '    Der Export-Dienst erzeugt bei Freigaben automatisch PDF, DXF und STEP. Er braucht eine SolidWorks-Lizenz und sollte auf einem PC laufen, der tagsüber an ist.'
$ans = Read-Host '    Auf diesem PC einrichten? [j/N]'
if ($ans -match '^[jJyY]') {
  $exe = Join-Path $dest 'ExportWorker\AperioPlan.ExportWorker.exe'
  $action = New-ScheduledTaskAction -Execute $exe -Argument '--formats pdf,dxf,step --interval 20'
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName
  Register-ScheduledTask -TaskName 'AperioPlan Export-Dienst' -Action $action -Trigger $trigger -User $UserName -Force | Out-Null
  Send-Hello 'export' $swVersion
  Ok 'Export-Dienst startet bei jeder Anmeldung'
}

$cli = Join-Path $dest 'Cli'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((Test-Path $cli) -and ($path -notlike "*$cli*")) { [Environment]::SetEnvironmentVariable('Path', "$path;$cli", 'User') }

Send-Hello 'cad' $swVersion
Write-Host ''
Write-Host "Verbunden mit $($cfg.server)" -ForegroundColor Green
Write-Host 'Bitte SolidWorks (neu) starten. Im Menü erscheint „AperioPlan“.'
Read-Host 'Enter drücken zum Beenden' | Out-Null
`;
}

function pcbPs1() {
  return String.raw`param([string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA, [string]$UserProfile = $env:USERPROFILE, [string]$UserName = "$env:USERDOMAIN\$env:USERNAME")
# AperioPlan PCB-Bridge – geführte Einrichtung (KiCad ab Version 8)
${COMMON_PS}
Write-Host 'AperioPlan PCB-Bridge – Einrichtung' -ForegroundColor White
Check-Server

Step 'KiCad suchen'
$cands = @()
foreach ($root in @($env:ProgramFiles, ${'${env:ProgramFiles(x86)}'}, (Join-Path $LocalAppData 'Programs'))) {
  if ($root -and (Test-Path (Join-Path $root 'KiCad'))) { $cands += Get-ChildItem (Join-Path $root 'KiCad') -Directory | ForEach-Object { Join-Path $_.FullName 'bin\kicad-cli.exe' } | Where-Object { Test-Path $_ } }
}
$cli = $cands | Sort-Object { [version](Split-Path (Split-Path (Split-Path $_ -Parent) -Parent) -Leaf + '.0') } -Descending -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cli) { Fail 'KiCad wurde auf diesem PC nicht gefunden.' 'Bitte KiCad ab Version 8 installieren (kicad.org) und die Einrichtung erneut starten.' }
$kv = (& $cli version).Trim()
if ([int]($kv.Split('.')[0]) -lt 8) { Fail "KiCad $kv ist zu alt." 'Die PCB-Bridge braucht KiCad ab Version 8 (kicad-cli).' }
Ok "Gefunden: KiCad $kv"

Step 'Programm laden'
$dest = Join-Path $LocalAppData 'AperioPlan\PCB-Bridge'
Get-ScheduledTask -TaskName 'AperioPlan PCB-Wächter' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-Process aperio-pcb -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Package 'pcb-win' $dest

Write-Settings 'pcb-bridge.json' @{ kicadCli = $cli }

Step 'Wächter beim Anmelden starten'
$exe = Join-Path $dest 'aperio-pcb.exe'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command & '$exe' watch"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName
Register-ScheduledTask -TaskName 'AperioPlan PCB-Wächter' -Action $action -Trigger $trigger -Force | Out-Null
Start-ScheduledTask -TaskName 'AperioPlan PCB-Wächter'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($path -notlike "*$dest*") { [Environment]::SetEnvironmentVariable('Path', "$path;$dest", 'User') }
Ok 'Wächter läuft und startet bei jeder Anmeldung'

Send-Hello 'pcb' "KiCad $kv"
Write-Host ''
Write-Host "Verbunden mit $($cfg.server)" -ForegroundColor Green
Write-Host 'Neue KiCad-Projekte im Arbeitsbereich werden erkannt; die Speichermaske öffnet sich im Browser.'
Write-Host 'Befehle: aperio-pcb checkout / checkin / status (Hilfe: aperio-pcb help)'
Read-Host 'Enter drücken zum Beenden' | Out-Null
`;
}

function pcbSh(platform: 'linux' | 'mac') {
  return `#!/bin/sh
# AperioPlan PCB-Bridge – geführte Einrichtung für ${platform === 'mac' ? 'macOS' : 'Linux'} (KiCad ab Version 8)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
CFG="$HERE/aperioplan-bridge.json"
val() { sed -n "s/.*\\"$1\\": *\\"\\([^\\"]*\\)\\".*/\\1/p" "$CFG" | head -n1; }
SERVER="$(val server)"; TOKEN="$(val token)"; VERSION="$(val version)"; PKG="$(val ${platform === 'mac' ? 'pcb-mac' : 'pcb-linux'})"
step() { printf '\\n==> %s\\n' "$1"; }
ok() { printf '    %s\\n' "$1"; }
fail() { printf '\\nFEHLER: %s\\n' "$1"; [ -n "$2" ] && printf 'Lösung: %s\\n' "$2"; exit 1; }

echo "AperioPlan PCB-Bridge – Einrichtung"
step "Verbindung zu $SERVER prüfen"
if ! OUT=$(curl -fsS --max-time 20 "$SERVER/api/health" 2>&1); then
  case "$OUT" in
    *certificate*|*SSL*) fail "Das Sicherheitszertifikat des Servers wird nicht anerkannt." "Stammzertifikat des AperioPlan-Servers im System hinterlegen (siehe Administrator-Handbuch) und erneut starten.";;
    *resolve*) fail "Der Server $SERVER wurde nicht gefunden." "Ist der Rechner im Firmennetz oder per VPN verbunden?";;
    *) fail "Der Server antwortet nicht ($OUT)." "Läuft AperioPlan? Lässt die Firewall die Verbindung zu?";;
  esac
fi
ok "Server erreichbar"
curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER/api/auth/me" >/dev/null 2>&1 || fail "Der Zugangsschlüssel wurde nicht angenommen." "Bitte in AperioPlan ein neues Installationspaket herunterladen."

step "KiCad suchen"
KICAD_CLI="$(command -v kicad-cli || true)"
[ -z "$KICAD_CLI" ] && [ -x /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli ] && KICAD_CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
[ -z "$KICAD_CLI" ] && fail "KiCad wurde nicht gefunden." "Bitte KiCad ab Version 8 installieren (kicad.org)."
KV="$("$KICAD_CLI" version | tr -d '\\r')"
[ "\${KV%%.*}" -lt 8 ] 2>/dev/null && fail "KiCad $KV ist zu alt." "Die PCB-Bridge braucht KiCad ab Version 8."
ok "Gefunden: KiCad $KV"

step "Programm laden"
DEST="$HOME/.local/share/aperioplan/pcb-bridge"
mkdir -p "$DEST"
case "$PKG" in http*) URL="$PKG";; *) URL="$SERVER$PKG";; esac
curl -fsSL -H "Authorization: Bearer $TOKEN" "$URL" -o /tmp/aperio-pcb.tar.gz || fail "Das Programmpaket konnte nicht geladen werden." "Der Administrator legt die Pakete in den Download-Ordner des Servers – oder der Rechner braucht Zugang zu github.com."
tar -xzf /tmp/aperio-pcb.tar.gz -C "$DEST" && rm -f /tmp/aperio-pcb.tar.gz
chmod +x "$DEST/aperio-pcb"
mkdir -p "$HOME/.local/bin" && ln -sf "$DEST/aperio-pcb" "$HOME/.local/bin/aperio-pcb"
ok "Installiert nach $DEST"

CONF_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/AperioPlan"
mkdir -p "$CONF_DIR"
cat > "$CONF_DIR/pcb-bridge.json" <<EOF
{ "serverUrl": "$SERVER", "token": "$TOKEN", "workspace": "$HOME/AperioPlan/Arbeitsbereich", "kicadCli": "$KICAD_CLI" }
EOF
chmod 600 "$CONF_DIR/pcb-bridge.json"
ok "Einstellungen gespeichert"

step "Wächter beim Anmelden starten"
${platform === 'mac' ? `PLIST="$HOME/Library/LaunchAgents/de.aperioplan.pcb-bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.aperioplan.pcb-bridge</string>
  <key>ProgramArguments</key><array><string>$DEST/aperio-pcb</string><string>watch</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"` : `UNIT="$HOME/.config/systemd/user/aperioplan-pcb-bridge.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=AperioPlan PCB-Wächter
[Service]
ExecStart=$DEST/aperio-pcb watch
Restart=on-failure
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now aperioplan-pcb-bridge.service`}
ok "Wächter läuft"

curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d "{\\"kind\\":\\"pcb\\",\\"host\\":\\"$(hostname)\\",\\"os\\":\\"$(uname -sr)\\",\\"version\\":\\"$VERSION\\",\\"appVersion\\":\\"KiCad $KV\\"}" "$SERVER/api/bridge/hello" >/dev/null
printf '\\nVerbunden mit %s\\n' "$SERVER"
echo "Neue KiCad-Projekte im Arbeitsbereich werden erkannt; die Speichermaske öffnet sich im Browser."
`;
}

const README = (kind: BridgeKind, platform: string) => kind === 'cad'
  ? `AperioPlan CAD-Bridge – Einrichtung\r\n\r\n1. Diese ZIP-Datei entpacken.\r\n2. Doppelklick auf „Einrichten.cmd“ (fragt nach Administratorrechten).\r\n3. Am Ende steht „Verbunden mit …“. Danach SolidWorks neu starten.\r\n\r\nDie Datei aperioplan-bridge.json enthält Ihren persönlichen Zugangsschlüssel – bitte nicht weitergeben.\r\nWiderrufen: AperioPlan → Einstellungen → API-Schlüssel.\r\n`
  : platform === 'windows'
    ? `AperioPlan PCB-Bridge – Einrichtung\r\n\r\n1. Diese ZIP-Datei entpacken.\r\n2. Doppelklick auf „Einrichten.cmd“.\r\n3. Am Ende steht „Verbunden mit …“.\r\n\r\nDie Datei aperioplan-bridge.json enthält Ihren persönlichen Zugangsschlüssel – bitte nicht weitergeben.\r\nWiderrufen: AperioPlan → Einstellungen → API-Schlüssel.\r\n`
    : `AperioPlan PCB-Bridge – Einrichtung\n\n1. Diese ZIP-Datei entpacken.\n2. Im Terminal: sh einrichten.sh\n3. Am Ende steht „Verbunden mit …“.\n\nDie Datei aperioplan-bridge.json enthält Ihren persönlichen Zugangsschlüssel – bitte nicht weitergeben.\n`;

export function installerFiles(kind: BridgeKind, platform: 'windows' | 'linux' | 'mac', cfg: InstallerConfig): { name: string; text: string }[] {
  const json = JSON.stringify({ kind, server: cfg.server, token: cfg.token, user: cfg.user, version: cfg.version, packages: cfg.packages }, null, 2);
  const files = [{ name: 'aperioplan-bridge.json', text: json }, { name: 'LIESMICH.txt', text: README(kind, platform) }];
  if (platform === 'windows' || kind === 'cad') {
    files.push({ name: 'einrichten.ps1', text: BOM + crlf(kind === 'cad' ? cadPs1() : pcbPs1()) });
    files.push({ name: 'Einrichten.cmd', text: crlf('@echo off\nrem AperioPlan Einrichtung starten\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0einrichten.ps1"\n') });
  } else {
    files.push({ name: 'einrichten.sh', text: pcbSh(platform) });
  }
  return files;
}
