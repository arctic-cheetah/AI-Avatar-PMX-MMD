# 07 — Verify CA installation and investigate stale processes

Source checkpoint: **2026-11-17T22:17:15+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user supplied the output of installing libnss3-tools, importing the CA into
the system and NSS stores, and receiving an openssl OK result, while the extension
still logged TLS failures.

I verified that the proxy CA, system-store certificate and NSS-store certificate
matched. A certificate-verified TLS handshake through the running proxy succeeded.
Those observations established a working trust path for that test client,
not for every existing editor or Agent Host process.

Several editor processes predated the certificate update. Cached trust in a
background process was therefore the leading hypothesis, not a conclusively
proven root cause. I requested saving work, disabling rewriting, fully quitting
all VS Code instances and reopening, rather than repeatedly importing the CA.
Reload Window alone was insufficient to test that hypothesis.

The user subsequently reported successful request/rewrite events in checkpoint
08. This sequence supports the trust investigation but does not justify a broad
claim that any future TLS error has the same cause. The eventual native route
avoids this interception trust boundary entirely.
