# Natural Light Enforcer

Recalls the Hue `Natural Light` scene when a powered-off light comes back and its 
`zigbee_connectivity` status returns to `connected`.

Hue's `Natural Light` feature lets your lights use different hues depending on the time of day.
Unfortunately, this doesn't work when lights are physically turned off, and when then turned on,
they are often set up to recall the last turned off color, which can be jarring. This script makes
sure they snap back to the proper color as soon as a physical on change is detected.

## Setup

```bash
./find_hue_bridge.sh
./find_hue_api_key.sh
```

This writes `.hue_ip` and `.hue_api_key`.

## Run

```bash
./start.sh
```

## Monitor
Display an updated light connectivity table, for debugging

```bash
bash ./monitor_hue_signals.sh
```

