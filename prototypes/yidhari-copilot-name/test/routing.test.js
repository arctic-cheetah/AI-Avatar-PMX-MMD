'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enable, restore } = require('../routing');
function fixture(initial = {}) {
  const values = { ...initial }; let saved;
  return {
    values,
    config: {
      get: k => values[k],
      inspect: k => ({ globalValue: values[k] }),
      update: async (k, v) => { if (v === undefined) delete values[k]; else values[k] = v; }
    },
    state: { get: () => saved, update: async (_, v) => { saved = v; } }
  };
}
test('enable and restore absent profile overrides', async () => {
  const f = fixture(); await enable(f.config, f.state, 'http://127.0.0.1:8766', 2);
  assert.equal(f.values.proxy, 'http://127.0.0.1:8766');
  await restore(f.config, f.state, 2); assert.deepEqual(f.values, {});
});
test('restore preserves later user changes', async () => {
  const f = fixture({ proxySupport: 'off' });
  await enable(f.config, f.state, 'http://127.0.0.1:8766', 2);
  f.values.proxy = 'http://user-proxy:8080';
  await restore(f.config, f.state, 2);
  assert.deepEqual(f.values, { proxy: 'http://user-proxy:8080', proxySupport: 'off' });
});
test('reject existing proxy without mutation', async () => {
  const f = fixture({ proxy: 'http://corporate:8080' });
  await assert.rejects(enable(f.config, f.state, 'http://127.0.0.1:8766', 2), /existing proxy/i);
  assert.equal(f.state.get(), undefined);
});
test('partial update failure rolls back', async () => {
  const f = fixture(); const update = f.config.update; let failed = false;
  f.config.update = async (k, v) => {
    if (k === 'proxySupport' && !failed) { failed = true; throw Error('write failed'); }
    return update(k, v);
  };
  await assert.rejects(enable(f.config, f.state, 'http://127.0.0.1:8766', 2));
  assert.deepEqual(f.values, {});
});
