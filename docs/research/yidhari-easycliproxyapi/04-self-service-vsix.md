# 04 — Make local VSIX generation reproducible

Source checkpoint: **2026-11-17T21:41:35+11:00** (Australia/Sydney).
Timestamp field: `completedAt`; source turn metadata is in [ledger.json](ledger.json).
Retrospective research entry; attached code is a retained final snapshot.

The user asked to generate the extension package themselves (calling it VSX).
I added and verified a documented npm packaging command and a VS Code build
task. The request turn was interrupted, then completed in the following turn;
both are covered by this checkpoint.

```bash
cd prototypes/yidhari-copilot-name
npm run package
```

The retained package script pins @vscode/vsce to 4.1.1 and requires Node.js 22+
and npm. Ctrl+Shift+B runs the Yidhari: Build VSIX task. The build downloads the
packaging tool when needed and produces a .vsix beside package.json for Install
from VSIX. Packaging was verified during the original exchange.

This research archive includes the build task, source, packaging exclusions and
synthetic smoke tools. Generated packages remain ignored. Packaging is optional
for the eventual native EasyCLIProxyAPI route, which needs no VSIX.
See the [extension README](../../../prototypes/yidhari-copilot-name/README.md)
for the complete experimental setup.
