# Restoration status — 2026-10-17

Restored docs and renderer from surviving files and the conversation. This is a
functional reconstruction, not recovery of the original Git commits or a claim
of byte-for-byte identity.

## Preserved before editing

A compressed copy of the partially recovered docs, renderer, controller, README,
and requirements was saved to the attached SSD:
`/media/parrot/Backup/avatar-yidhari-before-restore-20261017.tar.gz`.

## Restored

- Expression controller: persistent loop weight, intensity-aware startLoop,
  setIntensity without stopping the loop, easing, neutral and missing-morph checks.
- Shared expressions.json: all 46 original preset names/weights preserved;
  intended-use descriptions reconstructed from chat.
- JSON loader, generated preview tooltips, candidate JSON export.
- HTML matching all recovered main/audition controls, portrait/test-bench CSS.
  CSS was recreated because the later original stylesheet was unavailable.
- Browser WebSocket client, transcript, reconnect/reset behaviour, and suppression
  of authoring overrides while a response is running.
- Shared-catalog and bridge usage docs, and the Applio/phoneme-alignment architecture.
  Documentation wording and the text diagram were reconstructed, not exactly recovered.

## Backend repair follow-up

The backend has now been reconstructed: streaming catalog-based tag parser,
Origin-restricted localhost WebSocket server, demo, llama-server SSE adapter,
project-local environment and regression tests. The recovery-era browser client
was preserved, including its choice to keep the mood on disconnect. Subsequent live verification passed against qwen3.8-27b on port 8080: streamed
expression events and tag-free text reached the WebSocket client.

No model assets, Git history, or external Applio installation were modified.
TTS and lip sync were plans before deletion and are still plans now.

## Checks

Passed JavaScript syntax checks for all renderer modules; controller checks for
loop intensity retention, live rescaling, neutral reset, invalid input and missing
morphs; HTML ID bindings; and equality of all 46 morph maps against the SSD backup.
Editor diagnostics were unavailable in this session. Browser rendering and live
backend connectivity have not yet been revalidated in this restoration.
