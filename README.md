# Natural Light Enforcer

Recalls the Hue `Natural Light` scene when a powered-off light comes back and its `zigbee_connectivity` status returns to `connected`.

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

```bash
bash ./monitor_hue_signals.sh
```

Display an updated light connectivity table, for debugging
