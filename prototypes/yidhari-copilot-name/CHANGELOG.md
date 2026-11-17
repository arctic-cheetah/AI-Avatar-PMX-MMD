# Changelog

## 0.0.5

- Add localEndpoint transport for EasyCLIProxyAPI and other loopback HTTP model
  servers. Forward the final model request to a separate upstream port so the
  SDK identity and provider-added style instructions can both be rewritten.
- Local mode changes no editor proxy settings and needs no certificate setup.
- Document manual model URL changes and restore steps. Restrict rewriting to
  the selected loopback upstream port and exact model paths.

## 0.0.4

- Add read-only Check Certificate Setup to distinguish configured CA files from
  certificates actually loaded by the extension host's Node TLS runtime.
- Document Ubuntu system/NSS trust setup after observed client TLS failures.

## 0.0.3

- Make certificate preparation explicitly show that routing is off.
- Show installed version, effective routing, certificate acknowledgement and
  per-process connection/request/TLS/rewrite counters in Show Status.
- Detect externally changed routing and let Enable repair stale owned settings.
- Log only fixed diagnostic event names and counts, without prompts or credentials.

## 0.0.2

- Rewrite the exact short/impersonal style instruction to friendly/concise.
- Rewrite both Copilot SDK identity sentences to identify as yidhari, an AI
  assistant in VS Code. Preserve ordinary technical mentions of the SDK.
- Retain the original GitHub Copilot identity rules and request-scope restrictions.
- Document VSIX installation as the preferred upgrade workflow.

## 0.0.1

- Initial local proxy POC with identity rewriting, settings recovery, and a
  VSIX package.
