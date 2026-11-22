# 02 — Build and try the separate extension prototype

Source checkpoint: **2026-11-17T20:48:35+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user requested a separate proof-of-concept directory and then asked whether
to open it in VS Code for testing. I created
[the extension prototype](../../../prototypes/yidhari-copilot-name/README.md)
inside the existing avatar repository and described its F5 isolated development
host and installable VSIX workflow.

The first version targeted recognised identity clauses containing GitHub Copilot
or github-copilot. It introduced a loopback interception proxy, explicit host/path
matching, rewrite counts, and disable/restore handling for editor proxy settings.
It did not globally rename arbitrary content, authentication, tools or model IDs.

The response at this checkpoint reported 14 automated checks and a synthetic
HTTPS test with certificate verification and streamed-response preservation.
The live extension UI and real managed-harness payload were still unverified.

The source attached to this archival checkpoint is the final retained extension
snapshot, version 0.0.5, including later diagnostics and forwarding work.
It is not a reconstruction of the original 0.0.1 source tree. Its changelog and
the subsequent entries describe the intervening changes; generated VSIX packages,
certificates and development profiles are excluded from Git.
