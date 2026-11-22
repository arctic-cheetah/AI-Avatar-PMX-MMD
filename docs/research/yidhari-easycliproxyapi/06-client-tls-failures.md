# 06 — Diagnose the runtime certificate boundary

Source checkpoint: **2026-11-17T22:05:10+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

After setup, the user still saw the SDK identity and repeated tls_client_failed
events. Their status showed routing on, acknowledged setup and zero replacements.
Connections were reaching the proxy, but TLS failed before eligible HTTP requests
could be inspected; changing matching rules could not resolve that failure.

I checked the relevant certificate environment of the running processes.
The Agent Host's trust context was not established by loading the certificate
in a separate Node process. The response provided Ubuntu system-CA and NSS
installation commands, followed by openssl verification and a full editor restart.

Version 0.0.4 added Yidhari: Check Certificate Setup. The original response
reported 29 checks. It explicitly said I had not changed the user's trust stores
and live rewriting remained unverified.

The 10:00 PM time in the user's pasted model conversation is a separate
observation. This checkpoint's Git date follows our chat response metadata.
The distinction between process readiness, successful TLS, request eligibility
and actual rewrite counts remained essential.
