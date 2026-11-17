'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnostics } = require('../diagnostics');
const base = { running: true, owned: false, proxy: '', port: 8766, support: 'on', certificateTrusted: false, counts: {} };
test('prepared proxy is explicitly routing off', () => {
  const result = diagnostics(base);
  assert.equal(result.routing, false);
  assert.match(result.hint, /Enable Name Rewrite/);
  assert.match(result.status, /routing off/);
});
test('configured routing with no traffic is not a rewrite success', () => {
  const result = diagnostics({ ...base, owned: true, proxy: 'http://127.0.0.1:8766' });
  assert.equal(result.routing, true);
  assert.match(result.hint, /No client connections/);
});
test('routing changed externally is detected despite backup existing', () => {
  assert.equal(diagnostics({ ...base, owned: true, proxy: 'http://elsewhere:8766' }).routing, false);
});
test('disabled proxy support is detected', () => {
  assert.equal(diagnostics({ ...base, owned: true, proxy: 'http://127.0.0.1:8766', support: 'off' }).routing, false);
});
test('TLS failures and no-match requests have distinct guidance', () => {
  const input = { ...base, owned: true, proxy: 'http://127.0.0.1:8766' };
  assert.match(diagnostics({ ...input, counts: { tls_client_failed: 1 } }).hint, /certificate trust/);
  assert.match(diagnostics({ ...input, counts: { client_connected: 1, model_request: 1, no_matching_instruction: 1 } }).hint, /no matching/);
});
test('local mode readiness does not claim editor proxy routing is enabled', () => {
  const result = diagnostics({ ...base, transport: 'localEndpoint' });
  assert.match(result.status, /local endpoint ready/);
  assert.match(result.hint, /custom model endpoint URL/);
  assert.doesNotMatch(result.status, /routing on/);
});
test('local mode reports actual replacements and stopped state', () => {
  const result = diagnostics({ ...base, transport: 'localEndpoint', counts: { rewritten: 1, replacements: 3 } });
  assert.match(result.status, /3 replacements/);
  assert.match(result.hint, /replacements observed/);
  assert.equal(diagnostics({ ...base, transport: 'localEndpoint', running: false }).routing, false);
});
