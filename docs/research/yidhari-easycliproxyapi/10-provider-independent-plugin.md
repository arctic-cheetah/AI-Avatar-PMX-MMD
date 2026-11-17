# 10 — Implement shared instruction rewriting inside the existing core

Source checkpoint: **2026-11-17T22:55:45+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

After applying the provider-specific approach, the user requested replacement
across providers. Provider-specific configuration did not provide a single shared
map, so I implemented the native yidhari-wording request-interceptor plugin for
CLIProxyAPI 8.0.76.

Version 0.1.0 registered C ABI 1/schema 10 hooks before and after credential
selection. It applied the same phrase map to supported instruction fields in
OpenAI Chat Completions, Responses, Claude and Gemini bodies. It introduced no
listener, TLS interception, model routing change or credential replacement.
User/assistant/tool content and unrelated JSON fields were outside edit scope.

The research included requirement tests before implementation, Go race/vet checks,
32 synthetic provider-label/protocol combinations through the real library,
and an isolated installed-core-to-mock-upstream test. An initial host metadata
registration failure was corrected before the host test passed. Provider labels
in synthetic tests do not constitute live coverage of those providers.

I installed the plugin with a private config backup and verified non-plugin
settings were unchanged. The response clearly required a core restart: the
library had not yet been mapped by the running service.

The [preserved source](../../../prototypes/yidhari-native-wording/README.md)
is the final 0.2.0 snapshot, including the later whole-name work in checkpoint 12.
It is not an invented historical 0.1.0 tree. Private backups, shared libraries,
generated headers and live credentials are excluded from this archive.
