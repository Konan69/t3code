#!/usr/bin/env bash
# Install an official T3 Code nightly and lay the local overlay on top of it.
#
# Why this exists: install-local-windows-bundle.cjs patches whatever ASARs are
# currently installed. Run on its own it keeps the overlay on a stale shell —
# on 11 Sep it pinned the app to 0.0.41-nightly.20260910.1507, and every later
# "update" left those files untouched, so features that shipped in 1520 (the
# device hub among them) never appeared. The overlay is only ever correct on
# top of the official shell for the same nightly, so this installs that shell
# first and then overlays it.
#
# Windows holds the installed files open while T3 Code runs, and an agent
# driving this usually runs inside T3 Code, so the job waits for every T3 Code
# process to exit rather than stopping them. Run it detached (systemd-run) so
# it outlives the session that started it.
#
# usage: swap-local-windows-install.sh <version> <official-installer.exe> <patched-linux-cli-archive>
set -euo pipefail

version=$1
installer=$2
cli_archive=$3

build_root=$(cd "$(dirname "$0")/.." && pwd)
install_dir=/mnt/c/Users/kixey/AppData/Local/Programs/t3code
resources=$install_dir/resources
app_exe="$install_dir/T3 Code (Nightly).exe"
image='T3 Code (Nightly).exe'

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

running() {
  tasklist.exe /FI "IMAGENAME eq $image" /FO CSV /NH 2>/dev/null | tr -d '\r' | grep -cF "\"$image\"" || true
}

# The installed version lives in app.asar's package.json, not in the exe name.
installed_version() {
  python3 - "$resources/app.asar" <<'PY'
import json, struct, sys
with open(sys.argv[1], 'rb') as f:
    head = f.read(16)
    header_size = struct.unpack('<I', head[4:8])[0]
    json_size = struct.unpack('<I', head[12:16])[0]
    index = json.loads(f.read(json_size).decode('utf-8', 'replace'))
    entry = index['files']['package.json']
    f.seek(8 + header_size + int(entry['offset']))
    print(json.loads(f.read(int(entry['size'])))['version'])
PY
}

for path in "$installer" "$cli_archive" "$build_root/apps/desktop/dist-electron" "$build_root/apps/server/dist"; do
  [ -e "$path" ] || { log "missing $path"; exit 1; }
done

for tool in tasklist.exe cmd.exe; do
  command -v "$tool" >/dev/null || { log "$tool is not on PATH; cannot see or start Windows processes"; exit 1; }
done

log "waiting for every T3 Code process to exit (quit T3 Code now)"
waited=0
while [ "$(running)" -gt 0 ]; do
  if [ "$waited" -ge 3600 ]; then
    log "T3 Code still running after an hour; nothing was changed"
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done
log "T3 Code has exited"

# Run the installer from a Windows path; launching it over \\wsl$ is slow and
# trips SmartScreen.
stage=/mnt/c/Users/kixey/AppData/Local/Temp/t3-update
mkdir -p "$stage"
if [ "$(realpath "$installer")" != "$(realpath -m "$stage/$(basename "$installer")")" ]; then
  cp "$installer" "$stage/"
fi
win_installer=$(wslpath -w "$stage/$(basename "$installer")")

# The in-app updater may already have installed this exact shell (and it
# replaces the overlay when it does), so only run the installer when needed.
if [ "$(installed_version)" = "$version" ]; then
  log "official shell $version already installed"
else
  log "installing official shell $(basename "$installer")"
  cmd.exe /c start /wait "" "$win_installer" /S
fi
found=$(installed_version)
if [ "$found" != "$version" ]; then
  log "official install reports $found, expected $version; overlay not applied"
  exit 1
fi
log "official shell installed: $found"

log "applying the local overlay"
node "$build_root/scripts/install-local-windows-bundle.cjs" "$build_root" "$resources" "$cli_archive"

grep -aqF 'const PROBE_TIMEOUT = seconds(60);' "$resources/app.asar" || {
  log '60-second WSL startup probe missing after install'
  exit 1
}
for marker in 'const CODEX_PROVIDER_PROBE_TIMEOUT_MS = 6e4;' 'resolveCodexProviderProbeCwd'; do
  grep -aqF "$marker" "$resources/server.asar" || { log "overlay marker missing after install: $marker"; exit 1; }
done
log "overlay verified on $(installed_version)"

log "relaunching T3 Code"
cmd.exe /c start "" "$(wslpath -w "$app_exe")"
log "done"
