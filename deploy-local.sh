#!/usr/bin/env bash
# Nasadí lokální build na VŠECHNA místa, ze kterých Codex Web GPT reálně spouští kód.
# Nasazení jen na jedno z nich selže tiše. Viz memory: codex-chatgpt-web-dva-bundly.
#
# Aplikace se sama aktualizuje a vytváří nové versions/<verze> adresáře. Nasazení buildu
# postaveného ze starší verze by byl tichý downgrade, proto se verze kontroluje a neshoda
# deploy zastaví.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW="$REPO/dist/runtime/app"
VERSIONS="$HOME/.codex-chatgpt-web/versions"
HELPER_DIR="$HOME/AppData/Local/Programs/Codex Web GPT/resources/runtime/app"
REPO_VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"
TS=$(date +%Y%m%d-%H%M%S)

# Aktivní verze = nejnovější nainstalovaný versions/<verze> adresář.
ACTIVE_DIR="$(ls -d "$VERSIONS"/*-win32-x64 2>/dev/null | grep -v '\.tmp-' | sort -V | tail -1)"
[ -n "$ACTIVE_DIR" ] || { echo "Nenalezen žádný nainstalovaný versions/ adresář."; exit 1; }
INSTALLED_VERSION="$(sed -n 's/.*"appVersion": "\([^"]*\)".*/\1/p' "$ACTIVE_DIR/manifest.json" | head -1)"

echo "repo:      $REPO_VERSION"
echo "instalace: $INSTALLED_VERSION  ($ACTIVE_DIR)"

if [ "$REPO_VERSION" != "$INSTALLED_VERSION" ]; then
  cat <<MSG

ZASTAVENO: repo staví $REPO_VERSION, ale nainstalovaná aplikace je $INSTALLED_VERSION.
Nasazení by přepsalo novější upstream build starším a tiše ztratilo jejich opravy.

Nejdřív dotáhni upstream a přenes na něj své commity:
  git remote add upstream https://github.com/miuuyy/codex-chatgpt-web.git   # jednorázově
  git fetch upstream --tags
  git rebase v$INSTALLED_VERSION
pak spusť tento skript znovu.
MSG
  exit 1
fi

BUN="$ACTIVE_DIR/runtime/bun.exe"
echo "== build =="
"$BUN" run "$REPO/scripts/build-runtime-bundle.ts" >/dev/null
echo "   ok"

echo "== nasazení =="
for dir in "$ACTIVE_DIR/app" "$HELPER_DIR"; do
  [ -d "$dir" ] || { echo "   PŘESKOČENO (neexistuje): $dir"; continue; }
  for f in cli.js browser-helper.cjs; do
    [ -f "$NEW/$f" ] || continue
    cp "$dir/$f" "$dir/$f.bak-$TS" 2>/dev/null || true
    cp "$NEW/$f" "$dir/$f"
    echo "   $f -> $dir"
  done
done

echo "== ověření (bajt po bajtu proti buildu) =="
FAIL=0
for dir in "$ACTIVE_DIR/app" "$HELPER_DIR"; do
  [ -d "$dir" ] || continue
  for f in cli.js browser-helper.cjs; do
    [ -f "$dir/$f" ] || continue
    if cmp -s "$NEW/$f" "$dir/$f"; then echo "   OK    $dir/$f"
    else echo "   CHYBA $dir/$f se liší od buildu"; FAIL=1; fi
  done
done

echo
echo "== běžící procesy (ověř, že cesty sedí) =="
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -match '^(bun|Codex Web GPT)\.exe\$' -and \$_.CommandLine -match 'cli\.js|browser-helper' } | Select-Object -ExpandProperty CommandLine" 2>/dev/null | sed 's/^/   /' || true

echo
[ "$FAIL" = 0 ] && echo "HOTOVO. Restartuj launcher, aby se načetl nový kód." || { echo "NĚCO SE NENASADILO."; exit 1; }
