'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { inspectCertificateTrust } = require('../certificates');
const ca = tls.rootCertificates[0];
test('loaded trust is independent of acknowledgement and configured file', () => {
  const result = inspectCertificateTrust(ca, [], ca);
  assert.equal(result.extraFileContainsCA, true);
  assert.equal(result.loadedDefaultContainsCA, false);
});
test('matches certificate fingerprint despite PEM whitespace differences', () => {
  const result = inspectCertificateTrust(ca, [ca.replaceAll('\n', '\r\n')], '');
  assert.equal(result.loadedDefaultContainsCA, true);
  assert.equal(result.extraFileContainsCA, false);
});
test('unavailable default CA API is unknown rather than untrusted', () => {
  assert.equal(inspectCertificateTrust(ca, undefined, '').loadedDefaultContainsCA, null);
});
test('invalid PEM entries do not hide a later valid certificate', () => {
  assert.equal(inspectCertificateTrust(ca, ['invalid', ca], 'invalid').loadedDefaultContainsCA, true);
  assert.throws(() => inspectCertificateTrust('invalid', [], ''));
});
