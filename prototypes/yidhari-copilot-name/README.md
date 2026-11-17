# Yidhari Copilot Name — experimental VS Code extension

**Preferred EasyCLIProxyAPI setup:** use the [native wording plugin guide](../../docs/easycliproxyapi-yidhari.md).
It applies one shared map inside the existing core and was confirmed in the
user's live chat. The VSIX/mitmproxy routes below are retained as experiments;
they are not needed for that native setup.

Changes `github-copilot` and `GitHub Copilot` to `yidhari` only inside recognised
identity clauses in system/developer instructions. This is a standalone POC;
it does not depend on the avatar application or the deprecated chat participant API.

Version 0.0.2 also rewrites these exact instructions at sentence/line boundaries:

- `Keep your answers short and impersonal.` → `Keep your answers friendly and concise.`
  The reversed wording `impersonal and short` is supported too.
- `You are an AI assistant using Copilot SDK in VS Code.` →
  `You are yidhari, an AI assistant in VS Code.`
- `When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code.` →
  `When asked about your identity, you must state that you are yidhari, an AI assistant in VS Code.`

These are targeted instruction edits. Ordinary references to the Copilot SDK,
user/tool content, and other instructions are preserved. Counts include both
identity and style replacements. The user reported Yidhari self-identification
after installing 0.0.1; model self-report alone does not verify the wire payload.

## Install / upgrade (preferred workflow)

1. Run **Yidhari: Disable Name Rewrite** before upgrading to stop the old proxy.
2. Use **Extensions: Install from VSIX** and select the new version's package.
3. Reload VS Code if prompted, then run **Yidhari: Enable Name Rewrite**.
   Existing certificate setup is reused under the same extension identifier.
4. Start a fresh Copilot conversation and check **Yidhari: Show Status** for
   replacement counts. Existing history can still contain earlier wording.

F5 remains an optional developer workflow; release artifacts are VSIX packages.

## Native EasyCLIProxyAPI configuration (preferred for Devin)

For a provider-independent shared map, see the sibling
[native wording plugin](../yidhari-native-wording/README.md). It uses the existing
core's request-interceptor hook rather than another proxy/listener. The provider
settings below remain useful for provider-specific configuration.

Use the existing proxy's native system-prompt replacement feature when routing
through the Devin provider. An additional proxy/listener is not required.
Investigation found EasyCLIProxyAPI 0.3.22 bundling CLIProxyAPI core 8.0.60;
`sensitive-words-replace` was introduced in core 8.0.65. Upgrade the core to a
compatible release before using this configuration; the desktop and core
version numbers are separate.

Merge [the example mapping](examples/easycliproxyapi-yidhari.yaml) into the
existing `oauth.providers.devin` section of the v8 configuration. Preserve other
settings and do not create duplicate `oauth`/`providers` keys. The example only
changes the known style and SDK identity sentences. It applies to Devin system
prompts; it does not change requests made directly to GitHub or another provider.

Source: https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.65
Implementation: https://github.com/router-for-me/CLIProxyAPI/commit/9a7e1e6b412747729dedecefd7e23bd2e3ee1d3d

Restore the VS Code endpoint URL to `http://127.0.0.1:8317` if it was changed,
then disable the experimental Name Rewrite extension before testing the native
configuration. After saving/reloading the core configuration, use a fresh
conversation. Configuration persistence and a model self-report alone do not
prove the final provider payload was rewritten; live validation remains needed.
No core upgrade, live configuration edit or service restart was performed here.

The GitHub-model test also retained the SDK identity. Therefore, the earlier
claim that the custom endpoint alone explained all remaining identity text was
too strong; the GitHub-route issue remains unresolved.

## Optional local forwarding mode (EasyCLIProxyAPI)

The configured EasyCLIProxyAPI model URL is `http://127.0.0.1:8317`. Requests
to that URL are separate from the default GitHub HTTPS interception targets.
VS Code's model-provider adapter prepends the short/impersonal instruction;
the Agent Host supplies the SDK identity. Rewriting only GitHub requests does
not establish that the final custom-model request was rewritten.

Version 0.0.5 adds **localEndpoint** transport. It forwards HTTP requests from
`127.0.0.1:8766` to `127.0.0.1:8317`, applying the same targeted JSON rules to
the final provider request. It requires no TLS interception or CA setup because
both legs are HTTP loopback, matching the existing endpoint's transport.

1. Disable Name Rewrite before changing transport.
2. Install 0.0.5 and set **Yidhari Name: Transport** to **localEndpoint** in User
   Settings. The upstream port defaults to 8317; the listener port stays 8766.
3. Run **Yidhari: Enable Name Rewrite**. This starts the forwarding listener
   without changing VS Code's `http.proxy` settings.
4. In **Chat: Manage Language Models**, edit the EasyCLIProxyAPI custom model
   endpoint URL from `http://127.0.0.1:8317` to `http://127.0.0.1:8766` (preserve
   any existing path suffix). Keep the model ID and credentials as configured.
   Select that edited model in a new conversation.
5. Check for `model_request` and `rewritten` events. Expect three replacements
   for the exact style plus two SDK identity clauses shown above, if all three
   occur in the final payload. Different payloads can produce different counts.

To undo, restore the model URL to port 8317 **before** disabling the listener.
The extension does not edit model endpoint configuration automatically. Keeping
the model pointed at 8766 after stopping the extension will fail to connect.
The upstream port must differ from the listener port to prevent a forwarding loop.
Local mode accepts only loopback HTTP on the selected upstream port and exact
configured model paths. It preserves user messages, tools and streamed responses.
The upstream server must already be running; the extension does not start it.

## Build your own VSIX

Open this extension's source folder in VS Code. Packaging requires **Node.js
22 or newer and npm**. The first build needs internet access to fetch the
pinned `@vscode/vsce@4.1.1` packaging tool; no global VSCE installation or
Marketplace account is required. Python and mitmproxy are needed to run the
proxy, not to package the extension.

In the terminal for this folder, run:

```bash
npm run package
```

Or press **Ctrl+Shift+B** (**Cmd+Shift+B** on macOS) and run the default
**Yidhari: Build VSIX** task. You can also select it through **Tasks: Run Build
Task** in the Command Palette. The task runs the same command in this folder.

The output appears beside `package.json` as
`yidhari-copilot-name-poc-<version>.vsix`, using the version in `package.json`
(currently `yidhari-copilot-name-poc-0.0.5.vsix`). Building the same version
again replaces that artifact. Follow the install/upgrade steps above to use it.
Packaging creates a local file; it does not publish or install the extension.

After source changes, run `npm test` before packaging. Packaging itself does
not run tests. Increment `version` in `package.json` when preparing a new
release. The package excludes tests, development tooling, the development
profile, and previously built VSIX files via `.vscodeignore`.

## Acceptance criteria / design

- An extension-managed mitmdump process listens on IPv4 loopback only.
- Only exact configured HTTPS hosts and model paths are rewritten.
- Support JSON Chat Completions messages, Responses instructions/input, and
  Anthropic system strings/text blocks. Unknown protocols pass through.
- Only clauses such as `You are GitHub Copilot`, `Your name is GitHub Copilot`,
  and `When asked for your name, you must respond with "GitHub Copilot"`, plus
  the exact SDK identity and style clauses documented above, change.
  User/tool messages, model identifiers, other policy text, tools and responses
  remain unchanged. This intentionally misses unrecognised identity wording.
- Report counts/status only; do not persist flows, headers, prompts or responses.
- Keep TLS verification enabled. Trust the dedicated CA explicitly before routing.
- Back up profile proxy settings before enabling; restore only values still
  owned by this extension. Recover after an extension-host crash on next activation.
- No live Copilot compatibility claim until tested on the actual request route.

## Develop and test

Requires VS Code 1.100+, Node 20+, Python 3.10+, and an installed `mitmdump`.
There are no npm runtime dependencies. Set `yidhariName.mitmdumpPath` if needed.

```bash
npm test
```

Open this folder in VS Code and press F5. In the **Extension Development Host**,
open a disposable workspace folder. F5 uses `.dev-profile/` as an isolated
user-data directory; you may need to sign in to GitHub in that window. Run
commands there, not in your main editor. This directory is gitignored and
excluded from the VSIX because it can contain account/session data.
Remote SSH/WSL/container windows are intentionally unsupported in this first POC.

## Local setup and use

1. Run **Yidhari: Prepare Proxy Certificate**. This starts the proxy without
   changing routing, generates its dedicated CA, and opens its directory.
2. Trust **mitmproxy-ca-cert.pem** in the certificate store used by the VS Code
   Agent Host. Never share `mitmproxy-ca.pem`: it includes the private key.
   See https://docs.mitmproxy.org/stable/concepts/certificates/ .
   On Linux, a process-specific option is to launch the test VS Code process with
   `NODE_EXTRA_CA_CERTS=/absolute/path/to/mitmproxy-ca-cert.pem`; the runtime's
   use of that variable still needs verification. Fully exit that test process
   before relaunching. Do not disable TLS verification.
3. Set **Yidhari Name: Certificate Trusted** in the test profile after completing
   that setup. This records your setup acknowledgement, not a TLS test result.
4. Run **Yidhari: Enable Name Rewrite** in the disposable workspace. This sets
   profile `http.proxy` and `http.proxySupport`. VS Code declares these settings
   at machine scope, so workspace settings are insufficient. Use the isolated
   development profile supplied by F5.
   Existing nonempty proxy configurations are rejected to avoid breaking a
   corporate/upstream proxy chain. Multi-root workspaces are unsupported.
5. Start a **new Copilot harness** conversation. Ask its name, then try a harmless
   tool operation. Use **Yidhari: Show Status** to inspect rewrite counts.
6. Run **Yidhari: Disable Name Rewrite** to restore routing and stop the proxy.

### Linux process-scoped certificate setup

For a standard installed VSIX, the generated public CA is normally at:
`~/.config/Code/User/globalStorage/yidhari-local.yidhari-copilot-name-poc/proxy-ca/mitmproxy-ca-cert.pem`.
Use the directory opened by Prepare if you use another profile/user-data path.

To configure extra CA trust for a test launch without installing a system-wide
root, save your work and **fully quit all VS Code processes**. From an external
terminal, launch the extension workspace with the public CA path:

```bash
NODE_EXTRA_CA_CERTS="$HOME/.config/Code/User/globalStorage/yidhari-local.yidhari-copilot-name-poc/proxy-ca/mitmproxy-ca-cert.pem" \
  code /path/to/yidhari-copilot-name
```

Node reads this variable at process startup. Opening another window in an
already-running instance does not reliably apply it. This launch configuration
must be repeated for future launches; actual Agent Host trust remains to be
validated with the request/TLS counters in your installed version.

In that VS Code instance, open Settings and search
`@ext:yidhari-local.yidhari-copilot-name-poc`. Enable **Certificate Trusted**
to acknowledge the completed setup, then run **Yidhari: Enable Name Rewrite**.
The setting is also `"yidhariName.certificateTrusted": true` in user settings.
It does not install a certificate or prove trust by itself. If
`tls_client_failed` appears, disable routing and investigate the Agent Host's
certificate store; do not disable TLS verification.

### Ubuntu system and NSS trust (when client TLS still fails)

VS Code's Linux guidance recommends both the system and NSS stores:
https://code.visualstudio.com/docs/setup/network#_ssl-certificates .
The following commands deliberately trust this local proxy CA beyond a single
VS Code process. Run them only when you want that trust scope. The extension
does not run them automatically. Use the public `mitmproxy-ca-cert.pem`, never
the private-key-bearing `mitmproxy-ca.pem`.

Disable Name Rewrite first. On Ubuntu, for the default installed profile:

```bash
sudo apt-get install libnss3-tools
sudo install -m 0644 "$HOME/.config/Code/User/globalStorage/yidhari-local.yidhari-copilot-name-poc/proxy-ca/mitmproxy-ca-cert.pem" /usr/local/share/ca-certificates/yidhari-copilot-proxy.crt
sudo update-ca-certificates
mkdir -p "$HOME/.pki/nssdb"
if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
  certutil -N --empty-password -d "sql:$HOME/.pki/nssdb"
fi
certutil -A -d "sql:$HOME/.pki/nssdb" -n "Yidhari Copilot Proxy CA" -t "C,," -i "$HOME/.config/Code/User/globalStorage/yidhari-local.yidhari-copilot-name-poc/proxy-ca/mitmproxy-ca-cert.pem"
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt "$HOME/.config/Code/User/globalStorage/yidhari-local.yidhari-copilot-name-poc/proxy-ca/mitmproxy-ca-cert.pem"
```

The final command must report `OK`. Fully quit and relaunch VS Code to refresh
cached CA lists, acknowledge Certificate Trusted, and enable rewriting. Check
Certificate Setup is an extension-host diagnostic; live Agent Host verification
still requires `http_request` / `model_request` / `rewritten` events after a chat.
If failures continue, disable routing rather than bypassing TLS verification.

To remove this trust later, disable rewriting, then run:

```bash
certutil -D -d "sql:$HOME/.pki/nssdb" -n "Yidhari Copilot Proxy CA"
sudo rm /usr/local/share/ca-certificates/yidhari-copilot-proxy.crt
sudo update-ca-certificates
```

The default exact hosts are `api.githubcopilot.com`,
`api.individual.githubcopilot.com`, `api.business.githubcopilot.com`, and
`api.enterprise.githubcopilot.com`. Default paths are `/chat/completions`,
`/v1/chat/completions`, `/responses`, `/v1/responses`, `/v1/messages`.
These are candidate routes, not a claim about your Copilot session. Configure
verified hosts/paths if your provider uses another endpoint. Nonallowlisted
hosts are tunneled without TLS interception. Allowlisted hosts are decrypted,
but only the configured paths and recognised instruction fields are edited.

## Limits / troubleshooting

- If `connect_allowed` is followed by `tls_client_failed` with zero HTTP/model
  requests, TLS failed before the addon could inspect any prompt. Do not debug
  name matching until the certificate problem is resolved.
- **Yidhari: Check Certificate Setup** checks whether the extension host's actual
  Node default CA list contains this proxy CA (by SHA-256 fingerprint). It also
  reports whether its configured extra CA file contains it. These are separate
  checks: the setting/environment can be present without a loaded certificate.
  This does not prove Chromium or the separate Agent Host trusts the certificate.
  The command only reads the public CA and certificate stores; it changes no trust.
- `ready` means only that the proxy started. **Prepare Proxy Certificate does
  not enable routing.** Complete CA trust, set Certificate Trusted, and run
  **Yidhari: Enable Name Rewrite**. Look for `Routing enabled` before testing.
- Version 0.0.3 diagnostics must distinguish proxy running / routing off from
  routing on / no traffic and traffic received / no matching instruction.
  **Show Status** reports the extension version, effective routing state,
  certificate-setup acknowledgement, and per-process event counters. Counters
  include client connections, CONNECT tunnel classification, HTTP requests,
  eligible model requests, TLS failures, skip reasons and replacements.
  Only fixed event names and counts are logged, never prompt bodies, credentials,
  destination URLs, or raw TLS error strings. A client connection alone does not
  prove model traffic, and a model's self-identification does not prove rewriting.
- WebSocket, protobuf, and unknown request structures are not rewritten. Zero
  rewrites can mean routing bypass, unsupported format, or no matching identity.
- Requests over 4 MiB and compressed requests are passed through unchanged.
  Normal uncompressed JSON requests are supported; responses stream untouched.
- If TLS fails, disable routing and fix CA trust. An accepted proxy connection
  does not prove the Agent Host trusts the CA or uses this proxy.
- The pre-proxy VS Code debug view may show the original text. Verify the
  counter plus model behavior; never log credentials for diagnosis.
- Proxy settings affect other requests in that profile. Use the isolated development
  profile to avoid disrupting other work. Do not enable in multiple windows.
- If the extension is removed or VS Code is killed before recovery, remove the
  two profile `http.proxy` / `http.proxySupport` overrides manually. The
  previous values are also kept in extension global state until restored.
- This modifies request identity, not the UI branding or underlying model.
- No automatic CA installation, credential handling, commits or publication.

## References

- https://code.visualstudio.com/updates/v1_146#_copilot-sessions-behind-enterprise-proxies
- https://docs.mitmproxy.org/stable/api/mitmproxy/http.html
- https://code.visualstudio.com/api/references/vscode-api

## Validation recorded during implementation

Version 0.0.5:

- Inspected configured model URLs: the EasyCLIProxyAPI route uses loopback HTTP
  on port 8317, outside the existing GitHub HTTPS interception scope. The
  installed provider renderer prepends the short/impersonal policy/tone block;
  the Agent Host supplies the SDK identity. This explains why GitHub rewrite
  counts alone do not validate the final custom-model payload.
- New local payload and launch tests failed before implementation, then passed.
- `tools/smoke_local.py` uses the production launch-plan builder and temporary
  loopback servers. It verifies exactly three final-payload replacements for
  the style and two SDK identity sentences; user content, tools, model ID and
  SSE output are preserved. No real model calls or credentials were used.
- The user must install the VSIX, select localEndpoint and change the selected
  custom model URL before live behavior can be validated. No live model settings
  were changed during implementation.

Version 0.0.4:

- User logs showed allowed CONNECT requests followed by client TLS failures,
  with zero HTTP/model requests. The running proxy inherited only the system
  CA bundle, not the dedicated proxy CA. An OpenSSL check confirmed that the
  system CA bundle did not trust the proxy CA at investigation time.
- New certificate tests failed before implementation and passed afterward.
- No system/NSS trust changes were performed by the coding agent.

Version 0.0.3:

- Confirmed the installed 0.0.2 proxy was running; the inspected VS Code profiles
  had no proxy routing override. The user confirmed only Prepare had been run.
  This explains the startup-only log; the earlier model self-report was not
  evidence of successful interception.
- New diagnostic tests first failed for missing status/event behavior, then
  passed. The local HTTPS smoke test observed connection, CONNECT, HTTP request,
  eligible model request, and four replacements, with verified TLS on both legs.
- Live routing and certificate trust still require setup in the user's VS Code
  process. No live routing or CA trust store was changed during debugging.

Version 0.0.2:

- New style/SDK identity tests failed for the expected missing transformations
  before implementation, then passed. Fourteen Python tests plus four Node
  routing tests passed (18 total).
- The updated HTTPS smoke test verified the original name rule, both SDK
  identity sentences, and the friendly/concise style rule through the proxy.
  User content, the Markdown instruction, and SSE response were preserved.
- Packaged as `yidhari-copilot-name-poc-0.0.2.vsix`. Live 0.0.2 Copilot behavior
  still needs verification after installation; no running installation was changed.

Initial 0.0.1 validation:

- Rewrite tests first failed on three expected missing transformations, then passed.
- Routing tests first failed for missing enable/reject/rollback behavior, then passed.
- Four Node routing tests and ten Python rewrite/mitmproxy adapter tests passed.
  On this machine, adapter tests use `/usr/bin/python3`; the default `python3`
  lacks mitmproxy and skips those four adapter tests.
- `tools/smoke_proxy.py` passed against a temporary local HTTPS upstream with
  mitmproxy 8.1.1: both TLS legs verified, identity rewritten, user message and
  SSE response preserved. All listeners and temporary certificates cleaned up.
- JavaScript syntax checked; VSIX packaged with VSCE 4.1.1.
- VS Code 1.146.0 is installed. F5 UI behavior and live Copilot requests remain
  unverified. No live proxy settings or certificate trust stores were changed.

To rerun the full Python checks and encrypted loopback smoke test where
mitmproxy is installed for the system Python:

```bash
/usr/bin/python3 -m unittest discover -s test -v
/usr/bin/python3 tools/smoke_proxy.py
```

Use **Extensions: Install from VSIX** with the generated package if you prefer
installation over F5. Keep the initial trial in an isolated test profile.
`npm run package` uses the pinned VSCE packaging tool and may download it.
