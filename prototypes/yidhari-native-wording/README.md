# Yidhari wording — native CLIProxyAPI plugin

A native request-interceptor plugin for CLIProxyAPI 8.0.76. One replacement map
applies independent of the selected provider; no listener, proxy hop, CA, model
routing, auth or response modification is introduced.

**Looking for the installable plugin?** This is its source directory; the sibling
`yidhari-copilot-name` folder contains the earlier VS Code extension experiment.
Build this directory to generate `yidhari-wording.so` (ignored by Git), then
install it in the core's plugin directory. See [install on another machine](install.md).

**Primary user guide:** [Yidhari identity and friendly replies through
EasyCLIProxyAPI](../../docs/easycliproxyapi-yidhari.md). It includes the complete
setup, daily use, configuration, verification, upgrades and rollback workflow.

## Intended behavior

- Version 0.3.1 adds a cached `persona-file`: inject a local Markdown instruction
  file once per supported model request, preserving its exact text and the
  existing harness instructions. See [persona setup and validation](persona.md).
- Version 0.2.0 adds `word-replacements` alongside the existing literal phrase
  map. The example maps `Copilot`, `github-copilot`, and `GitHub Copilot` to
  `yidhari`, and standalone `impersonal` to `friendly`, case-insensitively.
  Whole-name boundaries exclude adjacent Unicode
  letters/numbers/combining marks, underscores and hyphens: `copilot-cli` and
  `my_copilot` remain intact. Punctuation around a standalone name is allowed.
  This intentionally changes ordinary standalone name mentions in instruction
  text too, while user/assistant/tool messages remain outside the edit scope.
- Literal and whole-name rules share one longest-first, non-cascading pass;
  literal phrase rules take precedence if the same key appears in both maps.
- Run before and after credential selection using the core's C ABI plugin hook.
- Recognise OpenAI Chat Completions system/developer messages, Responses
  instructions and system/developer input, Claude system text/blocks, and Gemini
  systemInstruction/system_instruction parts. Provider names do not select rules.
- Replace configured literal phrases in a longest-first, case-insensitive,
  single pass. Default example edits only known identity/style sentences.
- Preserve user/assistant/tool content, tool schemas, model IDs, unknown fields,
  and number spelling. Unknown/malformed JSON passes through unchanged.
- Reapplying the supplied example map is idempotent. Custom maps must avoid
  rewriting their own output because both hook phases may see the same body.
- No prompt/credential logs. Optional logs contain only replacement counts.
- Bodies larger than 16 MiB pass through unchanged.
- This covers supported instruction formats reaching the core interceptor, not
  requests sent directly to GitHub or outside CLIProxyAPI. A provider may insert
  additional identity downstream of this hook; live provider validation remains
  necessary. This is not a claim that every upstream identity is changeable.

## Build and validate

Linux amd64: Go 1.23+ with CGO and a C compiler. The only external Go dependency
is yaml.v3, pinned in go.mod/go.sum. Public C ABI definitions and RPC field names
were checked against the upstream v8.0.76 tag (ABI 1, schema 10).

```bash
go test ./...
go build -buildmode=c-shared -o yidhari-wording.so .
```

The generated .so base filename is the plugin ID: `yidhari-wording`. The core
also recognises `yidhari-wording-v0.3.1.so`. Install it into
`plugins/linux/amd64/` under the configured core plugin directory. Merge the
provided `config.example.yaml` into the existing plugins section, retaining
other plugins and settings. Use an absolute plugins.dir if configuring a custom
location. Restart the core after installing a native library. Rebuild/restart
for changes; do not overwrite a library while the core has it mapped.

Restore the model URL to the original EasyCLIProxyAPI port (8317) and disable
the earlier experimental VS Code proxy. Native provider-specific mappings can
remain if idempotent, but using one shared map avoids duplicate configuration.
Remove the plugin's `enabled` flag or set it false to disable; restart if the
host indicates unloading requires a restart. Keep the library until unloaded.

`config.example.yaml` is a merge fragment, not a complete replacement config.
No live configuration is edited by the build or tests. All local integration
checks use the real shared library with synthetic requests and no model calls.

## Historical installation (17 November 2026)

The plugin was installed for the user's CLIProxyAPI 8.0.76 instance at:

```text
/home/lyrebird/EasyCLIProxyAPI-v0.3.22-Linux-amd64/cpa-core/yidhari-native-plugins/linux/amd64/yidhari-wording-v0.2.0.so
```

Its existing `config.yaml` now enables plugins, points `plugins.dir` at the
dedicated `yidhari-native-plugins` directory, and includes this plugin's shared
four-entry phrase map and three whole-name aliases (0.2.0). Existing non-plugin
settings were verified unchanged. A private
0600 backup was created next to config.yaml with the prefix
`config.yaml.before-yidhari-wording-20261117T115413887851Z`.

At installation the library was not yet mapped. In the follow-up check on
17 November 2026, the running 8.0.76 core **had the library mapped**. The user
also supplied a live chat reporting the new Yidhari identity and friendly/concise
instruction. This is successful behavioral evidence for that session, not a
capture of the raw upstream payload or a test of every provider. The coding
agent did not restart the user's service or make a real upstream model call.

For rollback, stop the core, restore that config backup, then start the core.
The plugin directory may be removed after the library is no longer loaded.
The plugin's GitHubRepository metadata refers to the enclosing workspace
repository. This prototype is preserved on its local research branch; remote
publication is separate from the research archive.

The 0.2.0 upgrade was staged under a new filename without overwriting the loaded
0.1.0 library. At the deployment check, the running core still had the older
library mapped; restart the core to activate the word rules. Its private config
backup is `config.yaml.before-yidhari-words-20261117T124840246086Z` next to the
active config. To roll back to phrase-only matching, stop the core, remove the
new versioned library and restore that upgrade backup, then restart. Preserve
any later settings you want to retain rather than blindly restoring a backup.

## Validation

- Requirement tests failed before implementation, then passed.
- `go test -race ./...` and `go vet ./...` passed.
- `/usr/bin/python3 abi_smoke.py` loaded the actual shared library, registered
  and reconfigured it, checked 32 provider-label/protocol combinations and both
  interceptor phases, and verified that user content was preserved.
- `/usr/bin/python3 host_smoke.py` launched the installed 8.0.76 executable with
  temporary config and fake credentials; the native host loaded the plugin and
  rewrote all three known SDK/style clauses before a loopback mock upstream.
- The user subsequently confirmed live behavior in a chat. The automated checks
  did not exercise real providers; neither that chat nor the tests guarantee
  coverage for every provider, downstream prompt injection or unsupported format.

## Sources

- https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.76/examples/plugin/request-lifecycle
- https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.76/sdk/pluginapi/types.go
- https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.76/sdk/pluginabi/types.go
