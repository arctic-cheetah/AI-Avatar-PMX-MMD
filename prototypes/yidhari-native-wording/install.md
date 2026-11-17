# Install the native plugin on another machine

The native plugin source is in `prototypes/yidhari-native-wording/`.
`prototypes/yidhari-copilot-name/` is the older VS Code extension, not the native
EasyCLIProxyAPI plugin. No VSIX or MITM certificate is needed for this route.

The generated library is `yidhari-wording.so`, ignored by Git. Copy the source
folder to the new machine or obtain it from a repository revision containing
these changes. Local changes have not automatically been published to a remote.

## 1. Build (validated on Linux amd64)

Use CLIProxyAPI core 8.0.76 (ABI 1/schema 10), Go 1.23+, CGO and a C compiler.
The EasyCLIProxyAPI desktop version and its core version are separate. Other
platforms/architectures require a compatible native build and their own validation;
the Linux amd64 binary is not portable to Windows, macOS or ARM.

```bash
cd ~/Code/AI-Avatar-PMX-MMD/prototypes/yidhari-native-wording
go test ./...
go build -buildmode=c-shared -o yidhari-wording.so .
```

The build may download the pinned yaml.v3 dependency. Copying a prebuilt library
also requires compatible architecture and system C runtime; building on the
target machine is the reproducible path.

## 2. Install into the core's plugin directory

Stop the core from EasyCLIProxyAPI first. Find the core directory containing
the active `config.yaml`, not merely the desktop app's top-level directory.
Back up that config privately. If it already specifies `plugins.dir`, retain
that existing directory and other plugins. Otherwise choose an absolute root
such as `<core directory>/yidhari-native-plugins`.

From the build directory, set the chosen absolute plugin root, then copy:

```bash
plugin_root=/absolute/path/to/core/yidhari-native-plugins
install -d "$plugin_root/linux/amd64"
install -m 0644 yidhari-wording.so \
  "$plugin_root/linux/amd64/yidhari-wording-v0.3.1.so"
```

The path is a placeholder to replace on the new machine. Never overwrite a
library while a core has it mapped. The plugin ID remains `yidhari-wording` even
when the filename has the version suffix.

## 3. Merge configuration and start

Merge [config.example.yaml](config.example.yaml) into the active core config,
preserving existing settings/plugins and avoiding duplicate YAML keys. Set:

```yaml
plugins:
  enabled: true
  dir: /absolute/path/to/core/yidhari-native-plugins
  configs:
    yidhari-wording:
      enabled: true
      priority: 100
      # Keep the maps from config.example.yaml here too.
      # Optional: copy your persona file onto this machine and set its path.
      # persona-file: /absolute/path/to/yidhari-identity.instructions.md
```

`~` and environment variables are not expanded in `persona-file`; use an absolute
path readable by the core process. See [persona.md](persona.md) for file loading,
reload, deduplication and rollback. The user's personal instruction file is not
bundled into the library or repository.

The example's case-insensitive whole-word/name rules are:

| Instruction text | Replacement |
| --- | --- |
| `copilot` | `yidhari` |
| `github copilot` | `yidhari` |
| `github-copilot` | `yidhari` |
| `impersonal` | `friendly` |

Exact style sentences also change `short and impersonal` to `friendly and
concise`. Longer identifiers such as `copilot-cli`, `my_copilot` and
`impersonally` remain intact. Rules apply to supported instruction fields;
user/tool messages and the verbatim managed persona block remain unchanged.

Start the core in EasyCLIProxyAPI and use its original model endpoint in a fresh
chat. There is no second proxy hop. Check core plugin-loading status and test
the providers you actually use; model self-report alone is not proof of the
outgoing bytes. Updates to maps or the persona require plugin reconfiguration
or core restart. Restore the private config backup with the core stopped to
roll back, and retain older libraries until they are no longer loaded.

## Current machine and validation

The current machine's built library is
`~/Code/AI-Avatar-PMX-MMD/prototypes/yidhari-native-wording/yidhari-wording.so`.
The installed copy is:

```text
/home/lyrebird/EasyCLIProxyAPI-v0.3.22-Linux-amd64/cpa-core/yidhari-native-plugins/linux/amd64/yidhari-wording-v0.3.1.so
```

On 18 November 2026 the installed library matched the tested build, and the live
configuration was updated with the four whole-word/name rules above while
preserving the persona-file setting and phrase maps. A private configuration
backup was created before the update. Restart/reconfigure the core and start a
fresh chat to activate the settings; no live core restart was performed here.

The example-config regression first failed on standalone `IMPERSONAL`, then
passed after adding the new map entry. Go race tests and vet passed. Actual
shared-library ABI tests checked all four rules across 32 provider-label/protocol
cases; the isolated real-core test confirmed them at a mock upstream alongside
the unchanged persona file and user message. These are synthetic integration
checks, not live-provider validation.
