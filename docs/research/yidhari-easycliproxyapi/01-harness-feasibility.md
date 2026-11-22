# 01 — Investigate identity changes in the managed harness

Source checkpoint: **2026-11-17T20:33:00+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user asked whether a VS Code extension could replace the GitHub Copilot
identity in the new agent harness, noting the local harness deprecation. The
opening message also quoted an earlier conversation; that quotation is background,
not evidence that those suggestions were implemented here.

I checked the current harness and SDK interfaces. The earlier suggestion that
a custom chat participant could simply replace the managed session's system prompt
did not establish a supported hook into that session. SDK section customization
was relevant to extension-owned sessions, with a different ownership boundary.

I proposed a small proxy experiment to inspect and change eligible outgoing
instructions, initially favouring it before checking the existing EasyCLIProxyAPI
hooks. This became an exploratory detour, corrected in checkpoints 09 and 12.

Acceptance criteria were observable outgoing identity/style edits, preserved
non-target instructions and streamed responses, reversible routing, and no
claim of compatibility based only on the model saying its name. VS Code's visible
Copilot branding was outside scope. See the [later primary guide](../../easycliproxyapi-yidhari.md)
for the route eventually selected.
