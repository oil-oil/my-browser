#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo 'Usage: send-command.sh '\''{"type":"tabs"}'\'''
  exit 1
fi

curl -sS \
  -H 'content-type: application/json' \
  -d "$1" \
  http://127.0.0.1:17654/command
echo
