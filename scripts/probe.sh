#!/usr/bin/env bash
set -euo pipefail

echo "== Default browser handlers =="
plutil -p "$HOME/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist" \
  | rg -A8 -B2 'https|http' || true

echo
echo "== Installed browsers =="
ls /Applications | rg -i 'chrome|safari|edge|brave|arc|firefox' || true

echo
echo "== Chrome main processes =="
ps axww -o pid,ppid,command \
  | rg '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' || true

echo
echo "== CDP ports =="
for port in 9222 9333; do
  echo "-- $port --"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  curl -sS --max-time 1 "http://127.0.0.1:$port/json/version" || true
  echo
done

echo
echo "== Chrome AppleScript surface =="
osascript -e 'tell application "Google Chrome" to if it is running then return "windows=" & (count of windows) & ", tabs=" & (count of tabs of every window)' || true

