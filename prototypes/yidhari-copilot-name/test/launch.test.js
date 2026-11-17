'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLaunch } = require('../launch');
const options = { transport: 'localEndpoint', port: 8766, upstreamPort: 8317, hosts: ['api.githubcopilot.com'], paths: ['/chat/completions'], certDir: '/tmp/test-ca', addon: '/tmp/addon.py' };
test('local mode uses a fixed loopback reverse target', () => {
  const result = buildLaunch(options);
  assert.ok(result.args.includes('reverse:http://127.0.0.1:8317'));
  assert.ok(result.args.includes('127.0.0.1'));
  assert.ok(!result.args.includes('--allow-hosts'));
  assert.equal(result.env.YIDHARI_LOCAL_PORT, '8317');
});
test('upstream cannot loop to listener', () => {
  assert.throws(() => buildLaunch({ ...options, upstreamPort: 8766 }), /different/);
});
test('regular mode retains the exact HTTPS host allowlist', () => {
  const result = buildLaunch({ ...options, transport: 'httpsProxy' });
  assert.ok(result.args.includes('--allow-hosts'));
  assert.equal(result.env.YIDHARI_LOCAL_PORT, '');
});
test('reject bad transport and ports', () => {
  for (const update of [{ transport: 'invalid' }, { upstreamPort: '8317' }, { port: 0 }])
    assert.throws(() => buildLaunch({ ...options, ...update }));
});
