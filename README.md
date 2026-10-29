# Natural Light Enforcer

[Philips Hue](https://www.philips-hue.com/)'s "Natural Light" feature lets your Hue lights adjust their color depending on time of day- bright white in the morning, sunlight color during the day, golden in the evening, and darker ambers at night.
But for lights that use a physical "off" switch, turning back on at a different time of day can be jarring, as Hue only keeps light colors in sync with the time of day if they are powered on the whole time. This script watches for signs of a light powering on, and forces it to update to the currently appropriate Natural Light setting.

## Setup

```sh
./find_hue_bridge.sh
./find_hue_api_key.sh
```

This writes `.hue_ip` and `.hue_api_key`.

## Run

```sh
./start.sh
```

If the saved bridge address stops responding, the enforcer automatically runs
local discovery (with Hue cloud discovery as a fallback), verifies the discovered
bridge with the existing API key, saves its new address, and reconnects. This
works during startup and while running. Discovery attempts are limited to once
per 30 seconds; startup retries every 5 seconds while the bridge is offline.

To refresh the address manually:

```sh
./find_hue_bridge.sh
./start.sh
```

Reserve the bridge's IP address in your router's DHCP settings to keep it stable.

## Monitor
Display an updated light connectivity table, for debugging

```sh
./monitor_hue_signals.sh
```

