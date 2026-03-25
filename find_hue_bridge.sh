#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_FILE="$ROOT_DIR/.hue_ip"

# Discovery order:
# 1) Local SSDP broadcast (LAN-only, no internet dependency)
# 2) Hue cloud discovery endpoint fallback
FOUND_IP="$({
python3 - <<'PY'
from __future__ import annotations

import re
import socket
import sys
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import json


def discover_via_ssdp(timeout: float = 3.0) -> str | None:
    msg = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST:239.255.255.250:1900\r\n"
        "MAN:\"ssdp:discover\"\r\n"
        "MX:2\r\n"
        "ST:upnp:rootdevice\r\n\r\n"
    ).encode("ascii")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(timeout)
    try:
        sock.sendto(msg, ("239.255.255.250", 1900))

        candidates: list[str] = []
        while True:
            try:
                data, _ = sock.recvfrom(8192)
            except socket.timeout:
                break

            text = data.decode("utf-8", errors="ignore")
            m = re.search(r"(?im)^location:\s*(\S+)\s*$", text)
            if m:
                candidates.append(m.group(1))

        seen: set[str] = set()
        for url in candidates:
            if url in seen:
                continue
            seen.add(url)
            try:
                with urllib.request.urlopen(url, timeout=2) as resp:
                    xml_data = resp.read()
            except Exception:
                continue

            try:
                root = ET.fromstring(xml_data)
            except ET.ParseError:
                continue

            joined = " ".join(
                [el.text.strip() for el in root.iter() if el.text and el.text.strip()]
            ).lower()
            if "philips hue" not in joined and "ipbridge" not in joined and "hue bridge" not in joined:
                continue

            m_ip = re.search(r"https?://(\d+\.\d+\.\d+\.\d+)", url)
            if m_ip:
                return m_ip.group(1)

        return None
    finally:
        sock.close()


def discover_via_meethue() -> str | None:
    try:
        req = urllib.request.Request(
            "https://discovery.meethue.com/",
            headers={"Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        if isinstance(payload, list) and payload:
            first = payload[0]
            if isinstance(first, dict):
                ip = first.get("internalipaddress")
                if isinstance(ip, str) and ip:
                    return ip
    except Exception:
        return None
    return None


ip = discover_via_ssdp() or discover_via_meethue()
if not ip:
    sys.exit(1)
print(ip)
PY
} || true)"

if [[ -z "$FOUND_IP" ]]; then
  echo "Unable to discover Hue Bridge IP on the local network." >&2
  echo "Write the bridge IP into $OUT_FILE manually." >&2
  exit 1
fi

printf '%s\n' "$FOUND_IP" > "$OUT_FILE"
echo "Discovered Hue Bridge IP: $FOUND_IP"
echo "Saved to $OUT_FILE"
