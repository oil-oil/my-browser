#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="idkehddnilelcbbeebnmkombjaekhdoe"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_PATH="$ROOT_DIR/local-browser-operator-extension"

if [[ ! -f "$EXTENSION_PATH/manifest.json" ]]; then
  echo "Extension manifest not found: $EXTENSION_PATH/manifest.json"
  exit 1
fi

echo "Extension path:"
echo "$EXTENSION_PATH"
echo

if /usr/bin/open -a "Google Chrome" "chrome://extensions/?id=$EXTENSION_ID" >/dev/null 2>&1; then
  echo "Opened Chrome extension management page."
else
  /usr/bin/open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || true
  echo "Opened chrome://extensions."
fi

cat <<EOF

If the extension is already installed:
  1. Find "Local Browser Operator Lab".
  2. Click the reload button.
  3. Accept any new permission prompt.

If the extension is not installed:
  1. Turn on Developer mode.
  2. Click "Load unpacked".
  3. Paste this path:
     $EXTENSION_PATH
  4. Confirm permissions.

Chrome requires the user to approve extension installation and permission changes.
The agent can open the right page and prepare the path, but it cannot safely bypass that browser approval step.
EOF
