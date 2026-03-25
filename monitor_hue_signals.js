#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const POLL_MS = 1000;
const HIGHLIGHT_MS = 5000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function readFirstToken(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/\S+/);
  return match ? match[0] : '';
}

function loadConfig() {
  const rootDir = __dirname;
  const bridgeIp = readFirstToken(path.join(rootDir, '.hue_ip'));
  const appKey = readFirstToken(path.join(rootDir, '.hue_api_key'));
  if (!bridgeIp || !appKey) {
    throw new Error('Missing .hue_ip or .hue_api_key');
  }
  return { bridgeIp, appKey };
}

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
}

function timeOnly() {
  return new Date().toISOString().slice(11, 19);
}

function truncate(text, width) {
  const value = String(text ?? '');
  if (value.length <= width) {
    return value.padEnd(width, ' ');
  }
  return `${value.slice(0, width - 1)}…`;
}

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function highlight(text, width, previous, current, changedAt) {
  const value = truncate(text, width);
  if (previous === undefined || previous === current || typeof changedAt !== 'number' || Date.now() - changedAt > HIGHLIGHT_MS) {
    return value;
  }
  if (current === 'connected' || current === 'on') {
    return color(value, '32');
  }
  if (current === 'connectivity_issue' || current === 'off') {
    return color(value, '31');
  }
  return color(value, '33');
}

class HueClient {
  constructor(bridgeIp, appKey) {
    this.baseUrl = `https://${bridgeIp}/clip/v2`;
    this.appKey = appKey;
  }

  async getResource(resourceType) {
    const res = await fetch(`${this.baseUrl}/resource/${resourceType}`, {
      headers: {
        'hue-application-key': this.appKey,
        accept: 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const json = text ? JSON.parse(text) : {};
    return Array.isArray(json.data) ? json.data : [];
  }
}

function mapConnectivityByLight(devices) {
  const connectivityByLight = new Map();
  for (const device of devices) {
    const services = Array.isArray(device?.services) ? device.services : [];
    const lightIds = services.filter((service) => service?.rtype === 'light').map((service) => service.rid);
    const connectivityId = services.find((service) => service?.rtype === 'zigbee_connectivity')?.rid;
    if (!connectivityId) {
      continue;
    }
    for (const lightId of lightIds) {
      connectivityByLight.set(lightId, connectivityId);
    }
  }
  return connectivityByLight;
}

function buildRows(lights, connectivityRows, connectivityByLight, previous) {
  const connectivityMap = new Map();
  for (const row of connectivityRows) {
    if (typeof row?.id === 'string') {
      connectivityMap.set(row.id, row.status || '?');
    }
  }

  const next = new Map();
  const rows = [];
  for (const light of lights) {
    if (typeof light?.id !== 'string') {
      continue;
    }
    const lightId = light.id;
    const name = light?.metadata?.name || lightId;
    const on = light?.on?.on === true ? 'on' : light?.on?.on === false ? 'off' : '?';
    const connectivityId = connectivityByLight.get(lightId);
    const conn = connectivityId ? connectivityMap.get(connectivityId) || '?' : '-';
    const prev = previous.get(lightId) || {};
    const changed = prev.on !== undefined && (prev.on !== on || prev.conn !== conn);
    const changedAt = changed ? Date.now() : prev.changedAt;
    const lastChange = changedAt ? timeOnly() : '';
    const row = { lightId, name, on, conn, lastChange, changedAt };
    next.set(lightId, row);
    rows.push({ row, prev });
  }

  rows.sort((a, b) => a.row.name.localeCompare(b.row.name));
  return { rows, next };
}

async function main() {
  const { bridgeIp, appKey } = loadConfig();
  const client = new HueClient(bridgeIp, appKey);
  let previous = new Map();
  let cycles = 0;

  process.on('SIGINT', () => {
    process.stdout.write('\x1b[0m\x1b[?25h\n');
    process.exit(0);
  });

  while (true) {
    try {
      const [lights, devices, connectivityRows] = await Promise.all([
        client.getResource('light'),
        client.getResource('device'),
        client.getResource('zigbee_connectivity'),
      ]);

      const connectivityByLight = mapConnectivityByLight(devices);
      const { rows, next } = buildRows(lights, connectivityRows, connectivityByLight, previous);
      previous = next;
      cycles += 1;

      const out = [];
      out.push('\x1b[?25l');
      out.push('\x1b[2J\x1b[H');
      out.push(`Hue Signal Monitor  bridge=${bridgeIp}  poll=1s  refreshed=${ts()}`);
      out.push('');
      out.push([
        truncate('Name', 24),
        truncate('On', 5),
        truncate('Conn', 20),
        truncate('Last Change', 11),
      ].join('  '));
      out.push('-'.repeat(24 + 2 + 5 + 2 + 20 + 2 + 11));

      for (const { row, prev } of rows) {
        out.push([
          highlight(row.name, 24, prev.name, row.name, row.changedAt),
          highlight(row.on, 5, prev.on, row.on, row.changedAt),
          highlight(row.conn, 20, prev.conn, row.conn, row.changedAt),
          highlight(row.lastChange, 11, prev.lastChange, row.lastChange, row.changedAt),
        ].join('  '));
      }

      out.push('');
      out.push(`Cycles: ${cycles}`);
      out.push('Ctrl-C to exit.');
      process.stdout.write(out.join('\n'));
    } catch (err) {
      process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${color(`${ts()} ${err.message || err}`, '31')}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((err) => {
  process.stdout.write('\x1b[0m\x1b[?25h');
  console.error(err.message || err);
  process.exit(1);
});
