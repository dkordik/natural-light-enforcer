'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { HueClient } = require('./natural_light_enforcer');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const ok = (data) => new Response(JSON.stringify({ data, errors: [] }), { status: 200 });

test('concurrent failures discover once, verify key, save and retry at new address', async () => {
  let discoveries = 0;
  const saved = [];
  const client = new HueClient('192.0.2.1', 'key', {
    discover: async () => { discoveries++; return '192.0.2.2'; },
    save: ip => saved.push(ip),
  });
  client.streamController = new AbortController();
  global.fetch = async (url, options) => {
    if (url.includes('192.0.2.1')) throw new TypeError('fetch failed');
    assert.equal(options.headers['hue-application-key'], 'key');
    return ok([{ id: 'verified' }]);
  };
  const results = await Promise.all([client.getResource('light'), client.getResource('room')]);
  assert.equal(discoveries, 1);
  assert.deepEqual(saved, ['192.0.2.2']);
  assert.equal(client.bridgeIp, '192.0.2.2');
  assert.equal(client.streamController.signal.aborted, true);
  assert.equal(results[0][0].id, 'verified');
});

test('unavailable discovery preserves saved address and is rate limited', async () => {
  let discoveries = 0;
  const client = new HueClient('192.0.2.1', 'key', {
    discover: async () => { discoveries++; throw new Error('offline'); },
    save: () => assert.fail('must not save'),
  });
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(client.getResource('light'), /Cannot reach Hue bridge/);
  await assert.rejects(client.getResource('light'), /Cannot reach Hue bridge/);
  assert.equal(discoveries, 1);
  client.nextDiscoveryAt = 0;
  await assert.rejects(client.getResource('light'));
  assert.equal(discoveries, 2);
  assert.equal(client.bridgeIp, '192.0.2.1');
});

test('discovered bridge rejecting existing key is never saved or used', async () => {
  const client = new HueClient('192.0.2.1', 'key', {
    discover: async () => '192.0.2.2', save: () => assert.fail('must not save'),
  });
  global.fetch = async url => {
    if (url.includes('192.0.2.1')) throw new TypeError('fetch failed');
    return new Response('{}', { status: 403 });
  };
  await assert.rejects(client.getResource('light'), /Cannot reach Hue bridge/);
  assert.equal(client.bridgeIp, '192.0.2.1');
});

test('authentication errors on reachable bridge do not trigger discovery', async () => {
  const client = new HueClient('192.0.2.1', 'key', {
    discover: async () => assert.fail('must not discover'),
  });
  global.fetch = async () => new Response('{}', { status: 403 });
  await assert.rejects(client.getResource('light'), /HTTP 403/);
});
