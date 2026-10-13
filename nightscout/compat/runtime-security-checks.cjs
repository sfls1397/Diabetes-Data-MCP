'use strict';
const assert = require('node:assert/strict');
const expand = require('../lib/api/shared/expand-pattern');
const apn = require('../lib/server/apn-token');

describe('Diabetes runtime security replacements', function () {
  it('suppresses XState credential context logs in parent and invoked actors', function () {
    const fs = require('node:fs');
    const { createMachine, interpret, actions } = require('xstate');
    const safeConsole = require('nightscout-connect/diabetes-safe-console');
    assert.ok(fs.readFileSync(require.resolve('nightscout-connect'), 'utf8')
      .includes('interpret(things, { logger: console.log })'));
    const child = createMachine({ id: 'privacy-child', initial: 'ready', context: { password: 'fixture-private' },
      states: { ready: { entry: actions.log() } } });
    const parent = createMachine({ id: 'privacy-parent', initial: 'ready', context: { session: 'fixture-private' },
      states: { ready: { entry: actions.log(), invoke: { src: child } } } });
    const output = [];
    const original = console.log;
    console.log = (...args) => output.push(args);
    try {
      const actor = interpret(parent, { logger: safeConsole.log });
      actor.start();
      actor.stop();
      assert.deepEqual(output, []);
    } finally { console.log = original; }
  });
  it('preserves padded date and hour ranges and alternatives', function () {
    assert.deepEqual(expand('20{24..26}-10-T{08..09}'), [
      '2024-10-T08', '2024-10-T09', '2025-10-T08', '2025-10-T09', '2026-10-T08', '2026-10-T09'
    ]);
    assert.deepEqual(expand('{sgv,mbg}'), ['sgv', 'mbg']);
  });

  it('rejects deeply nested and oversized untrusted patterns', function () {
    assert.throws(() => expand('{'.repeat(1000) + 'x' + '}'.repeat(1000)), { status: 400 });
    assert.throws(() => expand('x'.repeat(4097)), { status: 400 });
    assert.ok(expand('{1..1000000000}').length <= 4096);
  });

  it('preserves APNs payloads, token auth and production/sandbox routing without network', async function () {
    for (const production of [true, false]) {
      const provider = new apn.Provider({ production, token: {
        teamId: 'TEAMID1234', keyId: 'TESTKEY123', key: Buffer.from('fixture')
      } });
      assert.equal(provider.client.host, production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com');
      await provider.client.destroy();
      let closed = false;
      let captured;
      provider.client = {
        send: async message => { captured = message; },
        close: async () => { closed = true; },
        destroy: async () => {}
      };
      const notification = Object.assign(new apn.Notification(), {
        alert: 'Fixture', topic: 'com.example.loop', contentAvailable: 1,
        interruptionLevel: 'time-sensitive', payload: { 'cancel-temporary-override': 'true' }
      });
      assert.deepEqual(await provider.send(notification, ['fixture-device']), {
        sent: [{ device: 'fixture-device' }], failed: []
      });
      assert.equal(captured.options.topic, notification.topic);
      assert.deepEqual(captured.buildApnsOptions(), {
        aps: { 'interruption-level': 'time-sensitive', alert: 'Fixture', 'content-available': 1 },
        'cancel-temporary-override': 'true'
      });
      assert.equal(closed, true);
    }
  });

  it('closes failed APNs sends and returns only a masked error reason', async function () {
    const provider = new apn.Provider({ token: {
      teamId: 'TEAMID1234', keyId: 'TESTKEY123', key: Buffer.from('fixture')
    } });
    await provider.client.destroy();
    let closed = false;
    provider.client = {
      send: async () => { throw Object.assign(new Error('sensitive request'), { reason: 'BadDeviceToken' }); },
      close: async () => { closed = true; }, destroy: async () => {}
    };
    assert.deepEqual(await provider.send(new apn.Notification(), ['fixture-device']), {
      sent: [], failed: [{ response: { reason: 'BadDeviceToken' } }]
    });
    assert.equal(closed, true);
  });
});
