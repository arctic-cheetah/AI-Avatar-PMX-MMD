# 13 — Plan request persona injection without implementing it

Source checkpoint: **2026-11-17T23:55:05+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user asked whether the Yidhari prompt could be added every time
EasyCLIProxyAPI was called, explicitly saying "Just plan here." I proposed
extending the native plugin rather than adding another proxy.

The plan was an external yidhari-persona.md selected by plugin configuration,
shared across model requests with optional provider/model filters. It would
populate the correct instruction fields for supported protocols while preserving
the existing harness instructions and name/style edits. "Every call" meant
eligible model requests reaching this hook, not health, authentication or
administrative endpoints.

A stable managed-block identifier would ensure one copy across the two hook
phases, retries and tool rounds. File/config reload would cache a stable version,
report only hash/version and injection status, and define missing/unreadable-file
behaviour, including retaining the last valid loaded persona. Stable text
supports caching, but increases input-token usage.

Planned validation covered fresh requests, follow-up tool rounds, retries,
updates, disabling, missing instruction fields and structured-output requirements
against a mock upstream, then fresh live chats. Avatar instructions would depend
on actual tool availability; downstream provider instructions could still matter.

This was and remains a plan only. No persona file, injection feature or live
persona configuration was added as part of this research archive.
