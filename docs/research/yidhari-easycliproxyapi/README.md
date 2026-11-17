# 🌸 Yidhari identity and tone research journal

A retrospective record of our conversation about replacing the managed harness's
Copilot identity and impersonal tone, ending with a native EasyCLIProxyAPI plugin.
The user requested fourteen commits in this existing avatar repository, backdated
to the chat, with persona injection deferred. This is a research archive, not a
verbatim transcript or a replay of historical source changes.

## Chronology and integrity

Archived on **18 November 2026**, Australia/Sydney, on
`codex/research-yidhari-easycliproxyapi` from base `e9ab58d`.
The fourteen commits group all original request/response turns, including the
interrupted packaging continuation and mid-turn clarifications. The opening
message's quoted earlier conversation is background, not a new experiment here.

[ledger.json](ledger.json) records original turn IDs, UTC start/completion times,
message counts and each commit's date. Git author and committer dates deliberately
use those original checkpoint times: the last covered completedAt, except the
active final turn uses its available startedAt. No timestamp estimates are used.
The display below is Australia/Sydney (UTC+11). Times embedded in pasted agent
chats are distinct from the metadata of our own research conversation.

The commits were created retrospectively. Prototype artifacts are the final
retained snapshots (extension 0.0.5, native plugin 0.2.0), attached to the relevant
research entry. They are not fabricated intermediate versions or evidence that
all current code existed at that earlier date. Historical test results are
attributed to their original responses; fresh archive checks are listed separately.

## Fourteen checkpoints

| # | Chat checkpoint (Australia/Sydney) | Research entry |
| --- | --- | --- |
| 01 | 2026-11-17T20:33:00+11:00 | [Investigate identity changes in the managed harness](01-harness-feasibility.md) |
| 02 | 2026-11-17T20:48:35+11:00 | [Build and try the separate extension prototype](02-proxy-proof-of-concept.md) |
| 03 | 2026-11-17T21:34:49+11:00 | [Extend the identity and friendly-style requirements](03-sdk-identity-and-style.md) |
| 04 | 2026-11-17T21:41:35+11:00 | [Make local VSIX generation reproducible](04-self-service-vsix.md) |
| 05 | 2026-11-17T21:58:54+11:00 | [Separate certificate preparation, acknowledgement and routing](05-enablement-and-trust.md) |
| 06 | 2026-11-17T22:05:10+11:00 | [Diagnose the runtime certificate boundary](06-client-tls-failures.md) |
| 07 | 2026-11-17T22:17:15+11:00 | [Verify CA installation and investigate stale processes](07-trust-store-verification.md) |
| 08 | 2026-11-17T22:34:54+11:00 | [Investigate partial replacement counts and the extra-hop experiment](08-partial-rewrites-and-forwarding.md) |
| 09 | 2026-11-17T22:42:49+11:00 | [Prefer the existing proxy's provider-specific controls](09-existing-proxy-controls.md) |
| 10 | 2026-11-17T22:55:45+11:00 | [Implement shared instruction rewriting inside the existing core](10-provider-independent-plugin.md) |
| 11 | 2026-11-17T23:12:06+11:00 | [Record the live result and document the primary route](11-live-result-and-guide.md) |
| 12 | 2026-11-17T23:50:13+11:00 | [Add whole-name aliases and reassess the MITM detour](12-whole-names-and-architecture.md) |
| 13 | 2026-11-17T23:55:05+11:00 | [Plan request persona injection without implementing it](13-persona-injection-plan.md) |
| 14 | 2026-11-18T00:31:31+11:00 | [Archive the conversation in the avatar repository](14-retrospective-and-handoff.md) |

## Outcome and evidence

The primary route uses the native request interceptor inside the existing
CLIProxyAPI core; no extra listener or interception CA is needed. It changes
supported instruction fields, preserving user/tool content and unrelated fields.
Synthetic provider labels establish format coverage, not live provider coverage.
The user supplied successful phrase-only 0.1.0 behaviour; the staged 0.2.0
whole-name update still required restart and fresh live verification at handoff.

- [Primary setup and rollback guide](../../easycliproxyapi-yidhari.md)
- [Native plugin source and development guide](../../../prototypes/yidhari-native-wording/README.md)
- [Experimental extension and proxy](../../../prototypes/yidhari-copilot-name/README.md)
- [Archive validation and limitations](validation.md)

Persona injection remains a plan in checkpoint 13. Private certificates, live
configuration, credentials, backup files, generated libraries/headers, VSIX files
and development profiles are excluded. Nothing is pushed as part of this archive.
