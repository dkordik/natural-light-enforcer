#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUE_IP_FILE="$ROOT_DIR/.hue_ip"
HUE_API_KEY_FILE="$ROOT_DIR/.hue_api_key"
FIND_BRIDGE_SCRIPT="$ROOT_DIR/find_hue_bridge.sh"

read_first_token() {
  local file="$1"
  if [[ -f "$file" ]]; then
    awk 'NF {print $1; exit}' "$file"
  fi
}

HUE_IP_VALUE="$(read_first_token "$HUE_IP_FILE" || true)"
if [[ -z "$HUE_IP_VALUE" ]]; then
  echo "Hue bridge IP not set; running discovery..."
  "$FIND_BRIDGE_SCRIPT"
  HUE_IP_VALUE="$(read_first_token "$HUE_IP_FILE" || true)"
fi
if [[ -z "$HUE_IP_VALUE" ]]; then
  echo "Unable to determine Hue bridge IP." >&2
  exit 2
fi

if [[ -n "$(read_first_token "$HUE_API_KEY_FILE" || true)" ]]; then
  echo "Hue API key already exists in $HUE_API_KEY_FILE"
  exit 0
fi

echo "Press the physical button on your Hue Bridge now."

for i in {1..20}; do
  RESPONSE="$(curl -k -sS -X POST "https://${HUE_IP_VALUE}/api" \
    -H 'Content-Type: application/json' \
    -d '{"devicetype":"natural_light_enforcer#node","generateclientkey":true}')"

  KEY="$(python3 - <<'PY' "$RESPONSE"
import json
import sys

raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)

if isinstance(data, list):
    for item in data:
        if isinstance(item, dict):
            success = item.get("success")
            if isinstance(success, dict):
                username = success.get("username")
                if isinstance(username, str) and username:
                    print(username)
                    raise SystemExit(0)
print("")
PY
)"

  if [[ -n "$KEY" ]]; then
    printf '%s\n' "$KEY" > "$HUE_API_KEY_FILE"
    echo "Created Hue API key and saved to $HUE_API_KEY_FILE"
    exit 0
  fi

  if echo "$RESPONSE" | grep -q '"type":101'; then
    echo "Waiting for button press... (${i}/20)"
    sleep 2
    continue
  fi

  echo "Unexpected Hue bridge response: $RESPONSE" >&2
  sleep 2
done

echo "Failed to create Hue API key (button press not detected in time)." >&2
exit 1
