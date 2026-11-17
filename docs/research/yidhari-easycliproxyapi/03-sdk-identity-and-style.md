# 03 — Extend the identity and friendly-style requirements

Source checkpoint: **2026-11-17T21:34:49+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

After installing the VSIX, the user reported a model calling itself Yidhari
while still describing its underlying identity as Copilot SDK in VS Code.
The same conversation confirmed the instruction to keep answers short and
impersonal. The user requested friendly and concise instead.

I added explicit transformations for both SDK identity sentences and the style
clause. The intended received instructions became:

```text
Keep your answers friendly and concise.
You are yidhari, an AI assistant in VS Code.
When asked about your identity, you must state that you are yidhari, an AI assistant in VS Code.
```

The 0.0.2 response reported 18 checks and a synthetic HTTPS rewrite check.
Installation, enabling routing and starting a fresh chat were still necessary
for live verification. A persona-layer self-description was not proof of
the underlying instruction bytes changing.

The user's pasted agent transcript showed 9:23 PM, while this chat turn arrived
later. Git uses the original timestamp of our research response, not a timestamp
embedded in that quoted external conversation. The
[retained regression tests](../../../prototypes/yidhari-copilot-name/test/test_rewrite.py)
cover instruction scope and preservation of unrelated messages.
