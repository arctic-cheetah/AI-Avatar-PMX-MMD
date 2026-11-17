# 11 — Record the live result and document the primary route

Source checkpoint: **2026-11-17T23:12:06+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user supplied a successful live conversation reporting the Yidhari identity
and friendly/concise wording, then requested documentation because EasyCLIProxyAPI
would be their primary route. A follow-up process check found the native library
mapped in the running core.

I created the [primary setup guide](../../easycliproxyapi-yidhari.md), linked it
from the root README and both prototypes, and documented configuration, building,
installation, daily use, troubleshooting, upgrades and rollback. The older
extension route was labelled experimental.

The supplied chat was successful behavioural evidence for that session.
It was not a captured upstream request and did not prove every provider worked.
The model's suggestion that rewrite.py was responsible was also not reliable
implementation attribution: this route used the native Go plugin inside
CLIProxyAPI.

The original documentation checks covered local links, shell syntax, YAML and
configuration consistency. The native phrase-only 0.1.0 result was confirmed;
the later whole-name 0.2.0 deployment had a separate restart/verification boundary.
Nothing in this checkpoint establishes a live result for a request that bypasses
EasyCLIProxyAPI.
