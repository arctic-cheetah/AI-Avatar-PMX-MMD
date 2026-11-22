# Persona-file support (0.3.1)

The native plugin can load a UTF-8 Markdown instruction file using `persona-file`.
The supplied VS Code instruction file is configuration data, not instructions
for the plugin or its developer. Its text is preserved verbatim inside a managed
instruction block; existing name/style rules apply outside that block.

Acceptance criteria:

- Load an absolute local file at registration/reconfiguration, cache it, and
  inject it into supported model requests across providers without an extra proxy.
- Preserve existing harness text, user/tool messages, model IDs and unknown fields.
- Keep one managed block across both hook phases, retries and persona updates.
- Support Chat Completions, Responses, Claude and Gemini, including missing
  instruction fields when SourceFormat identifies the request protocol.
- Reject unreadable, empty, invalid UTF-8, oversized files and reserved markers
  on reload; keep the previously loaded settings. Never log persona text.
- Disabling the file stops new injection; start a fresh chat to clear old context.

Configuration (merge into the existing plugin entry):

```yaml
plugins:
  configs:
    yidhari-wording:
      persona-file: /home/lyrebird/.config/Code/User/prompts/yidhari-identity.instructions.md
```

Use an absolute path accessible to the core process. The maximum file size is
64 KiB. Edits take effect on plugin reconfiguration or core restart, not on every
request. Failed reloads retain the last valid in-memory configuration; failed
initial loading does not activate the plugin. An empty/omitted setting disables
injection and leaves existing rewriting available. Only model requests reaching
the supported hook/formats are covered; health/auth/admin requests are not.

Build the 0.3.1 library as described in README.md, install under a new versioned
filename rather than overwriting a mapped library, update the existing config
and restart the core. Roll back by stopping the core, restoring its private
configuration backup and removing the new versioned library, then restarting.
The source instruction file is not modified or copied into the repository.

Persona text adds input tokens and is sent to the selected model provider.
Instructions remain subject to the receiving model's instruction hierarchy and
tool availability; this feature supplies no tools or additional permissions.

## Local rollout — 18 November 2026

Installed the tested library as `yidhari-wording-v0.3.1.so` under the existing
core's `yidhari-native-plugins/linux/amd64/` directory. The existing plugin
configuration now points `persona-file` at the supplied VS Code instruction
file above. Existing replacement maps and non-plugin settings were preserved.
A private 0600 config backup was created beside the live config:
`config.yaml.before-yidhari-persona-20261117T135506094638Z`.

The final build uses a new filename; older libraries, including an earlier staged
0.3.0 build, were left intact. The version suffix lets the core select 0.3.1.
**Restart the core in EasyCLIProxyAPI, then start a fresh chat to activate it.**
No live restart or real provider call was performed during this implementation.
The automated checks used fake credentials and a mock upstream.

## Validation

New requirement tests initially failed because persona support was absent.
A protocol-field regression test also failed before its fix. The final checks
passed: Go race tests, `go vet`, the actual shared-library ABI test (32 original
rewrite combinations plus 32 persona combinations), and an isolated 8.0.76 core
integration using the user's actual instruction file. At the mock upstream that
file arrived verbatim exactly once, with harness edits applied and user content
unchanged. Malformed files, failed reloads, missing fields, updates, disabling,
numeric preservation and repeated hook passes have regression coverage.

```bash
go test -race ./...
go vet ./...
go build -buildmode=c-shared -o yidhari-wording.so .
/usr/bin/python3 abi_smoke.py
YIDHARI_TEST_PERSONA=/home/lyrebird/.config/Code/User/prompts/yidhari-identity.instructions.md \
  /usr/bin/python3 host_smoke.py
```

Run from this prototype directory. The host smoke test binds only loopback and
launches its own temporary core; it neither uses live credentials nor edits the
live configuration. A successful mock test is not proof of every provider's
downstream treatment of the instructions.
