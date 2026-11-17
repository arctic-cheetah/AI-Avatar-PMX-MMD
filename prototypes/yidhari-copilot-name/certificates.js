'use strict';
const { X509Certificate } = require('node:crypto');
function inspectCertificateTrust(proxyPEM, defaultCAs, extraPEM) {
  const fingerprint = new X509Certificate(proxyPEM).fingerprint256;
  function contains(certs) {
    return certs.some(pem => {
      try { return new X509Certificate(pem).fingerprint256 === fingerprint; }
      catch { return false; }
    });
  }
  const extra = String(extraPEM || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  return {
    fingerprint,
    loadedDefaultContainsCA: Array.isArray(defaultCAs) ? contains(defaultCAs) : null,
    extraFileContainsCA: contains(extra)
  };
}
module.exports = { inspectCertificateTrust };
