# 08 — Investigate partial replacement counts and the extra-hop experiment

Source checkpoint: **2026-11-17T22:34:54+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user now supplied http_request, model_request and rewritten events with
a rising total. Their model nevertheless retained the SDK identity and
impersonal style. A replacement count established that some eligible instruction
matched; it did not establish complete coverage or identify which model call
produced the visible answer.

The displayed custom model route used EasyCLIProxyAPI. I initially attributed
the remaining problem too strongly to the loopback endpoint sitting outside
the HTTPS interception allowlist. I built version 0.0.5 with optional forwarding:

```text
VS Code → 127.0.0.1:8766 → EasyCLIProxyAPI on 127.0.0.1:8317
```

The response reported 37 checks and both synthetic forwarding smoke tests.
The extra hop was still a proposed live experiment, not a demonstrated fix for
all observed identity text.

This explanation was corrected in 09 after the user reproduced SDK identity
with a GitHub-provided model and explicitly rejected proxying the existing proxy.
The retained forwarding implementation is experimental history, not the primary
recommended architecture. The 10:25 PM pasted transcript is not the timestamp
used for this research commit.
