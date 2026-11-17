# 12 — Add whole-name aliases and reassess the MITM detour

Source checkpoint: **2026-11-17T23:50:13+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user asked to match Copilot and github-copilot as words and questioned
whether the MITM proxy had been necessary. I added native plugin version 0.2.0:

```yaml
word-replacements:
  "GitHub Copilot": "yidhari"
  "github-copilot": "yidhari"
  "Copilot": "yidhari"
```

Matches are case-insensitive within eligible instruction fields. Adjacent
Unicode letters, numbers, combining marks, underscores and hyphens block a
whole-name match, preserving identifiers such as copilot-cli and my_copilot.
Literal and whole-name rules share a longest-first non-cascading pass, with
literal rules winning duplicate keys. Ordinary standalone name mentions in
instructions now change too; user messages remain untouched.

The new tests failed before implementation, then passed with ABI and isolated
host checks. A versioned library was staged beside the already mapped 0.1.0
library, with a private backup. The response required a restart and fresh live
check; staging did not prove activation of 0.2.0.

I explicitly acknowledged that MITM was unnecessary for the user's primary
EasyCLIProxyAPI route. Its native hook supplies the needed editing point.
Checking existing lifecycle hooks first would have avoided the detour.
This does not resolve direct GitHub traffic outside that route.
