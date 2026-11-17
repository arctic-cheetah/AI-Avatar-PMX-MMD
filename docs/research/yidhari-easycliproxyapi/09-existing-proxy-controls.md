# 09 — Prefer the existing proxy's provider-specific controls

Source checkpoint: **2026-11-17T22:42:49+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user said "ideally we don't proxy the proxy" and supplied a GitHub-model
conversation still reporting Copilot SDK identity. They asked how to edit the
text inside their existing EasyCLIProxyAPI route.

I acknowledged that the previous loopback diagnosis overstated its explanatory
power. Inspection found the desktop app and CLIProxyAPI core had distinct
versions; the core initially lacked the newer Devin sensitive-words replacement
feature. The original exchange identified the relevant newer upstream feature
and prepared a provider-specific YAML merge example.

The [historical Devin example](../../../prototypes/yidhari-copilot-name/examples/easycliproxyapi-yidhari.yaml)
shows the four identity/style phrase edits. It is a configuration fragment,
not a complete service configuration or a global provider mechanism. The response
said the running service had not yet been upgraded or modified.

The next step was to use the original endpoint on port 8317, disable the
experimental extension, upgrade/configure the existing core and try a fresh
conversation. The user then requested provider-independent coverage. The direct
GitHub-model case remained unresolved and outside this native proxy route.
