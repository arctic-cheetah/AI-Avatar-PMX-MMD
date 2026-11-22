# 05 — Separate certificate preparation, acknowledgement and routing

Source checkpoint: **2026-11-17T21:58:54+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user reported zero replacements and a model still stating the original
SDK identity. When asked about setup, they clarified: "I only prepared the
certificate." Enabling then displayed the guard requiring certificate preparation,
CA trust configuration, and Certificate Trusted acknowledgement.

I distinguished a proxy process being ready from editor routing being enabled,
and added clearer status diagnostics in version 0.0.3. The response reported
25 checks and a local HTTPS smoke test, not successful live rewriting.

The user then asked how to perform step 4. I explained the User Settings checkbox:

```text
@id:yidhariName.certificateTrusted
```

That checkbox acknowledges setup; it neither installs a CA nor validates that
the Agent Host runtime trusts it. The intended observable chain was
http_request → model_request → rewritten. A zero count or ready event cannot
establish compatibility.

The original startup suggestion used NODE_EXTRA_CA_CERTS. Subsequent evidence
required examining the actual runtime and trust stores, recorded in 06–07.
Certificate verification remained enabled; the insecure settings from the
opening quoted advice were not the selected solution.
