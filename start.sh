#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUE_IP_FILE="$ROOT_DIR/.hue_ip"
HUE_API_KEY_FILE="$ROOT_DIR/.hue_api_key"

read_first_token() {
  local file="$1"
  local token
  if [[ -f "$file" ]]; then
    # Do not rely on awk from PATH: the deployment host can have an
    # incompatible Homebrew binary ahead of the system tools.
    while IFS= read -r token || [[ -n "$token" ]]; do
      if [[ "$token" =~ [^[:space:]] ]]; then
        printf '%s\n' "${token%%[[:space:]]*}"
        return 0
      fi
    done < "$file"
  fi
}

if [[ -z "$(read_first_token "$HUE_IP_FILE" || true)" ]]; then
  echo "Hue bridge IP not set; running discovery..."
  "$ROOT_DIR/find_hue_bridge.sh"
fi

if [[ -z "$(read_first_token "$HUE_API_KEY_FILE" || true)" ]]; then
  echo "Hue API key not set; running key setup..."
  "$ROOT_DIR/find_hue_api_key.sh"
fi

exec node "$ROOT_DIR/natural_light_enforcer.js"
