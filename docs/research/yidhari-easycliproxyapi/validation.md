# Research snapshot validation

Checks rerun while preparing the retrospective archive on 18 November 2026
(Australia/Sydney). These are separate from results reported at earlier checkpoints.

## Native plugin

From prototypes/yidhari-native-wording:

```bash
GOCACHE=/tmp/yidhari-go-cache GOPROXY=off go test -race ./...
GOCACHE=/tmp/yidhari-go-cache GOPROXY=off go vet ./...
GOCACHE=/tmp/yidhari-go-cache GOPROXY=off go build -buildmode=c-shared -o yidhari-wording.so .
/usr/bin/python3 abi_smoke.py
```

Passed. The real shared-library ABI smoke check exercised registration,
reconfiguration, 32 provider-label/protocol combinations, both hook phases,
idempotence with the example rules and preservation of user content.

From the repository root:

```bash
/usr/bin/python3 prototypes/yidhari-native-wording/host_smoke.py
```

Passed using the installed CLIProxyAPI 8.0.76 executable, temporary configuration,
fake credentials and a loopback mock upstream. The real host loaded the plugin
and applied the current example identity/style/name rules. The live service was
untouched, and no upstream model was called.

## Experimental extension

From prototypes/yidhari-copilot-name:

```bash
node --test test/*.test.js
/usr/bin/python3 -m unittest discover -s test -v
```

Passed: four Node test files and 18 Python tests, with no Python skips. System
Python was used because its mitmproxy installation permits the adapter checks.
These do not constitute a fresh VS Code UI or live managed-harness integration test.
Packaging and TLS/forwarding smoke results described in earlier entries are
historical session results, not newly claimed reruns for this archive.

## Archival checks and limits

Local Markdown links, the ledger's timestamp order and source-turn coverage,
Git whitespace, attribution, commit count/dates and the tracked-file inventory
are checked before handoff. Generated artifacts, private material and persona
injection are excluded. No tests were added merely to test documentation text.

No fresh provider call, direct GitHub-model compatibility check, service restart
or activation check of the staged native 0.2.0 installation is claimed. The
user's supplied live 0.1.0 chat remains behavioural evidence, not a raw upstream
capture. Provider-added instructions downstream of the hook may remain unchanged.
