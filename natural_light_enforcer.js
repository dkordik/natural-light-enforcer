#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const DEBOUNCE_SECONDS = 2;
const GROUP_DEBOUNCE_SECONDS = 2;
const CONNECTIVITY_POLL_MS = 1000;
const RECONNECT_DELAY_MS = 5000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function nowMonoSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

function ts() {
  return new Date().toISOString();
}

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

class HueClient {
  constructor(bridgeIp, appKey) {
    this.bridgeIp = bridgeIp;
    this.appKey = appKey;
    this.baseUrl = `https://${bridgeIp}/clip/v2`;
  }

  async request(method, pathName, body) {
    const res = await fetch(`${this.baseUrl}${pathName}`, {
      method,
      headers: {
        'hue-application-key': this.appKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json = {};
    if (text) {
      json = JSON.parse(text);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${method} ${pathName}: ${text}`);
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`Hue API errors for ${method} ${pathName}: ${JSON.stringify(json.errors)}`);
    }
    return json;
  }

  async getResource(resourceType) {
    const json = await this.request('GET', `/resource/${resourceType}`);
    return Array.isArray(json.data) ? json.data : [];
  }

  async getLightById(lightId) {
    const json = await this.request('GET', `/resource/light/${lightId}`);
    return Array.isArray(json.data) && json.data.length > 0 ? json.data[0] : null;
  }

  async recall(resourceType, resourceId) {
    const action = resourceType === 'smart_scene' ? 'activate' : 'active';
    const payload = { recall: { action } };
    try {
      await this.request('PUT', `/resource/${resourceType}/${resourceId}`, payload);
    } catch (putErr) {
      try {
        await this.request('POST', `/resource/${resourceType}/${resourceId}`, payload);
      } catch {
        throw putErr;
      }
    }
  }

  async openEventStream() {
    const res = await fetch(`https://${this.bridgeIp}/eventstream/clip/v2`, {
      method: 'GET',
      headers: {
        'hue-application-key': this.appKey,
        accept: 'text/event-stream',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} GET /eventstream/clip/v2: ${text}`);
    }
    if (!res.body) {
      throw new Error('No event stream body returned by bridge');
    }
    return res;
  }
}

function extractRidsByType(value, resourceType) {
  const found = new Set();

  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    const rid = node.rid;
    const nodeType = node.rtype || node.type;
    if (nodeType === resourceType && typeof rid === 'string') {
      found.add(rid);
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(value);
  return found;
}

function buildGroupToTarget(scenes, smartScenes) {
  const mapping = new Map();

  for (const item of scenes) {
    const name = item?.metadata?.name;
    const groupId = item?.group?.rid;
    const id = item?.id;
    if (typeof name === 'string' && name.trim().toLowerCase() === 'natural light' && typeof groupId === 'string' && typeof id === 'string') {
      mapping.set(groupId, { resourceType: 'scene', id });
    }
  }

  for (const item of smartScenes) {
    const name = item?.metadata?.name;
    const groupId = item?.group?.rid;
    const id = item?.id;
    if (typeof name === 'string' && name.trim().toLowerCase() === 'natural light' && typeof groupId === 'string' && typeof id === 'string') {
      mapping.set(groupId, { resourceType: 'smart_scene', id });
    }
  }

  return mapping;
}

function buildTopology(rooms, zones, devices) {
  const deviceToLights = new Map();
  const connectivityToLights = new Map();

  for (const device of devices) {
    if (!device || typeof device.id !== 'string') {
      continue;
    }
    const lights = extractRidsByType(device, 'light');
    if (lights.size > 0) {
      deviceToLights.set(device.id, lights);
    }
    for (const service of Array.isArray(device.services) ? device.services : []) {
      if (service?.rtype === 'zigbee_connectivity' && typeof service.rid === 'string') {
        connectivityToLights.set(service.rid, new Set(lights));
      }
    }
  }

  const roomIds = new Set(rooms.map((room) => room.id));
  const zoneIds = new Set(zones.map((zone) => zone.id));
  const lightToGroup = new Map();

  for (const group of [...rooms, ...zones]) {
    if (!group || typeof group.id !== 'string') {
      continue;
    }

    const resolvedLights = new Set(extractRidsByType(group, 'light'));
    for (const deviceId of extractRidsByType(group, 'device')) {
      const deviceLights = deviceToLights.get(deviceId);
      if (!deviceLights) {
        continue;
      }
      for (const lightId of deviceLights) {
        resolvedLights.add(lightId);
      }
    }

    for (const lightId of resolvedLights) {
      const existing = lightToGroup.get(lightId);
      if (!existing) {
        lightToGroup.set(lightId, group.id);
        continue;
      }
      if (zoneIds.has(existing) && roomIds.has(group.id)) {
        lightToGroup.set(lightId, group.id);
      }
    }
  }

  return { lightToGroup, connectivityToLights };
}

async function* iterSSEJsonEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line === '') {
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n');
          dataLines = [];
          try {
            yield JSON.parse(payload);
          } catch {
            console.log(`Skipping non-JSON SSE payload: ${payload.slice(0, 160)}`);
          }
        }
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
}

class NaturalLightEnforcer {
  constructor(client) {
    this.client = client;
    this.lightToGroup = new Map();
    this.groupToTarget = new Map();
    this.connectivityToLights = new Map();
    this.lastConnectivityStatus = new Map();
    this.lightNames = new Map();
    this.lastActivation = new Map();
    this.lastGroupActivation = new Map();
  }

  async refreshMappings() {
    console.log('Refreshing Hue mappings...');

    const [scenes, smartScenes, rooms, zones, devices, lights, connectivityRows] = await Promise.all([
      this.client.getResource('scene'),
      this.client.getResource('smart_scene').catch(() => []),
      this.client.getResource('room'),
      this.client.getResource('zone'),
      this.client.getResource('device'),
      this.client.getResource('light'),
      this.client.getResource('zigbee_connectivity').catch(() => []),
    ]);

    this.groupToTarget = buildGroupToTarget(scenes, smartScenes);
    const topology = buildTopology(rooms, zones, devices);
    this.lightToGroup = topology.lightToGroup;
    this.connectivityToLights = topology.connectivityToLights;

    this.lightNames.clear();
    for (const light of lights) {
      if (typeof light?.id === 'string' && typeof light?.metadata?.name === 'string' && light.metadata.name) {
        this.lightNames.set(light.id, light.metadata.name);
      }
    }

    this.lastConnectivityStatus.clear();
    for (const row of connectivityRows) {
      if (typeof row?.id === 'string' && typeof row?.status === 'string') {
        this.lastConnectivityStatus.set(row.id, row.status);
      }
    }

    console.log(`Mappings ready: ${this.lightToGroup.size} lights, ${this.groupToTarget.size} Natural Light targets`);
  }

  async handleLightConnected(lightId, source, connectivityId) {
    const light = await this.client.getLightById(lightId);
    if (!light) {
      return;
    }

    if (typeof light?.metadata?.name === 'string' && light.metadata.name) {
      this.lightNames.set(lightId, light.metadata.name);
    }

    const label = this.lightNames.get(lightId) || lightId;
    console.log(`[${ts()}] Light connected: ${label} (${lightId}) via ${source} ${connectivityId}`);

    if (light?.on?.on !== true) {
      return;
    }

    const now = nowMonoSeconds();
    const groupId = this.lightToGroup.get(lightId);
    if (!groupId) {
      return;
    }

    const target = this.groupToTarget.get(groupId);
    if (!target) {
      return;
    }

    const lastLight = this.lastActivation.get(lightId);
    if (typeof lastLight === 'number' && now - lastLight < DEBOUNCE_SECONDS) {
      return;
    }

    const lastGroup = this.lastGroupActivation.get(groupId);
    if (typeof lastGroup === 'number' && now - lastGroup < GROUP_DEBOUNCE_SECONDS) {
      return;
    }

    this.lastActivation.set(lightId, now);
    this.lastGroupActivation.set(groupId, now);

    try {
      await this.client.recall(target.resourceType, target.id);
      console.log(`Recalled Natural Light for ${label}`);
    } catch (err) {
      if (typeof lastLight === 'number') {
        this.lastActivation.set(lightId, lastLight);
      } else {
        this.lastActivation.delete(lightId);
      }
      if (typeof lastGroup === 'number') {
        this.lastGroupActivation.set(groupId, lastGroup);
      } else {
        this.lastGroupActivation.delete(groupId);
      }
      throw err;
    }
  }

  async pollConnectivityTransitions() {
    const rows = await this.client.getResource('zigbee_connectivity').catch(() => []);
    for (const row of rows) {
      const connectivityId = row?.id;
      const status = row?.status;
      if (typeof connectivityId !== 'string' || typeof status !== 'string') {
        continue;
      }
      const prev = this.lastConnectivityStatus.get(connectivityId);
      this.lastConnectivityStatus.set(connectivityId, status);
      if (prev && prev !== 'connected' && status === 'connected') {
        for (const lightId of this.connectivityToLights.get(connectivityId) || []) {
          await this.handleLightConnected(lightId, 'connectivity poll', connectivityId);
        }
      }
    }
  }

  async processPayload(payload) {
    for (const event of Array.isArray(payload) ? payload : [payload]) {
      if (!event || typeof event !== 'object' || !Array.isArray(event.data)) {
        continue;
      }
      for (const data of event.data) {
        if (data?.type !== 'zigbee_connectivity' || typeof data.id !== 'string' || typeof data.status !== 'string') {
          continue;
        }
        const prev = this.lastConnectivityStatus.get(data.id);
        this.lastConnectivityStatus.set(data.id, data.status);
        if (prev && prev !== 'connected' && data.status === 'connected') {
          for (const lightId of this.connectivityToLights.get(data.id) || []) {
            await this.handleLightConnected(lightId, 'connectivity event', data.id);
          }
        }
      }
    }
  }
}

async function main() {
  const { bridgeIp, appKey } = loadConfig();
  const client = new HueClient(bridgeIp, appKey);
  const enforcer = new NaturalLightEnforcer(client);

  await enforcer.refreshMappings();

  const pollTimer = setInterval(() => {
    enforcer.pollConnectivityTransitions().catch((err) => {
      console.error(`Connectivity poll error: ${err.message || err}`);
    });
  }, CONNECTIVITY_POLL_MS);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
  console.log('Connectivity polling enabled (1s interval)');

  while (true) {
    try {
      console.log('Connecting to Hue event stream...');
      const response = await client.openEventStream();
      console.log('Event stream connected');
      for await (const payload of iterSSEJsonEvents(response)) {
        await enforcer.processPayload(payload);
      }
      throw new Error('Event stream closed');
    } catch (err) {
      console.error(`Event stream error: ${err.message || err}`);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      await enforcer.refreshMappings().catch((refreshErr) => {
        console.error(`Mapping refresh failed: ${refreshErr.message || refreshErr}`);
      });
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
