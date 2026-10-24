// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceInput, cleanTranscript, requestTranscript, pickMimeType, MAX_RECORD_SECONDS, MIN_RECORD_MS,
} from "../../renderer/voice-input.js";
import { startFrame } from "../../renderer/bridge-client.js";

/** A VoiceInput with fake mic, recorder, clock and timer; `sent` collects bridge frames. */
function harness({ transcript = "Hello Yidhari", transcribeError = null, micError = null, blobSize = 2048 } = {}) {
  const log = { sent: [], statuses: [], states: [], uploads: [], tracksStopped: 0, timers: [] };
  let clock = 0;
  const stream = { getTracks: () => [{ stop: () => { log.tracksStopped += 1; } }] };
  const voice = new VoiceInput({
    openMicrophone: async () => { if (micError) throw micError; return stream; },
    createRecorder: (s) => ({
      start: () => {},
      stop: async () => { s.getTracks().forEach((track) => track.stop()); return { size: blobSize, type: "audio/webm" }; },
      cancel: () => s.getTracks().forEach((track) => track.stop()),
    }),
    transcribe: async (blob) => {
      log.uploads.push(blob);
      if (transcribeError) throw transcribeError;
      return transcript;
    },
    // The same path bridge-client.js uses: transcript → start frame on the socket.
    onTranscript: (text) => log.sent.push(startFrame(text)),
    onStatus: (text) => log.statuses.push(text),
    onState: (state) => log.states.push(state),
    now: () => clock,
    setTimer: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; },
    clearTimer: () => {},
  });
  return { voice, log, advance: (ms) => { clock += ms; } };
}

async function record(h, ms = 1500) {
  await h.voice.toggle(true);
  h.advance(ms);
  await h.voice.toggle(true);
}

test("a transcript is sent as a normal start prompt", async () => {
  const h = harness({ transcript: "  Hello   Yidhari, how are you?  " });
  await record(h);
  assert.deepEqual(h.log.sent.map((frame) => JSON.parse(frame)),
    [{ type: "start", prompt: "Hello Yidhari, how are you?" }]);
  assert.deepEqual(h.log.states, ["starting", "recording", "transcribing", "idle"]);
  assert.equal(h.log.tracksStopped, 1, "microphone released after recording");
});

test("an empty or punctuation-only transcript does not start a reply", async () => {
  for (const transcript of ["", "   ", " ... ", "?!"]) {
    const h = harness({ transcript });
    await record(h);
    assert.deepEqual(h.log.sent, [], JSON.stringify(transcript));
    assert.match(h.log.statuses.at(-1), /didn't catch that/);
    assert.equal(h.voice.state, "idle");
  }
});

test("an STT failure shows a status and does not send start", async () => {
  const h = harness({ transcribeError: new Error("Speech-to-text is unavailable; check the server log.") });
  await record(h);
  assert.deepEqual(h.log.sent, []);
  assert.match(h.log.statuses.at(-1), /Voice input failed · Speech-to-text is unavailable/);
  assert.equal(h.voice.state, "idle", "user can retry");
});

test("denied microphone permission explains itself and leaves typing available", async () => {
  const h = harness({ micError: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
  await h.voice.toggle(true);
  assert.equal(h.voice.state, "idle");
  assert.match(h.log.statuses.at(-1), /permission denied.*keep typing/);
  assert.deepEqual(h.log.uploads, []);
});

test("a missing microphone has its own message", async () => {
  const h = harness({ micError: Object.assign(new Error("none"), { name: "NotFoundError" }) });
  await h.voice.toggle(true);
  assert.match(h.log.statuses.at(-1), /No microphone found/);
});

test("very short clips are not uploaded", async () => {
  const h = harness();
  await record(h, MIN_RECORD_MS - 1);
  assert.deepEqual(h.log.uploads, []);
  assert.deepEqual(h.log.sent, []);
  assert.match(h.log.statuses.at(-1), /too short/);
});

test("an empty recording is not uploaded", async () => {
  const h = harness({ blobSize: 0 });
  await record(h);
  assert.deepEqual(h.log.uploads, []);
});

test("the mic does not start while the bridge is busy", async () => {
  const h = harness();
  await h.voice.toggle(false);
  assert.equal(h.voice.state, "idle");
  assert.deepEqual(h.log.states, []);
});

test("recording stops itself at the time limit", async () => {
  const h = harness();
  await h.voice.toggle(true);
  assert.equal(h.log.timers[0].ms, MAX_RECORD_SECONDS * 1000);
  h.advance(MAX_RECORD_SECONDS * 1000);
  await h.log.timers[0].fn();
  assert.equal(h.log.sent.length, 1);
});

test("cancel drops the recording without uploading it", async () => {
  const h = harness();
  await h.voice.toggle(true);
  h.voice.cancel();
  assert.equal(h.voice.state, "idle");
  assert.equal(h.log.tracksStopped, 1);
  assert.deepEqual(h.log.uploads, []);
});

test("cleanTranscript trims, caps length and rejects text with no letters or digits", () => {
  assert.equal(cleanTranscript(" a \n b "), "a b");
  assert.equal(cleanTranscript("こんにちは"), "こんにちは");
  assert.equal(cleanTranscript("42"), "42");
  assert.equal(cleanTranscript("—"), "");
  assert.equal(cleanTranscript(null), "");
  assert.equal(cleanTranscript("x".repeat(5000)).length, 2000);
});

test("requestTranscript posts the blob to /stt and surfaces server errors", async () => {
  const calls = [];
  const blob = { type: "audio/webm;codecs=opus" };
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ text: "hi" }) }; };
  assert.equal(await requestTranscript(blob, ok), "hi");
  assert.equal(calls[0].url, "/stt");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "audio/webm;codecs=opus");
  assert.equal(calls[0].init.body, blob);

  const refused = async () => ({ ok: false, status: 503, json: async () => ({ error: "Voice input is off; start serve.py with --stt." }) });
  await assert.rejects(requestTranscript(blob, refused), /--stt/);
  const broken = async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError("not json"); } });
  await assert.rejects(requestTranscript(blob, broken), /HTTP 500/);
});

test("pickMimeType prefers Opus in WebM, then Ogg, then MP4", () => {
  assert.equal(pickMimeType(() => true), "audio/webm;codecs=opus");
  assert.equal(pickMimeType((type) => type.startsWith("audio/ogg")), "audio/ogg;codecs=opus");
  assert.equal(pickMimeType(() => false), "");
});

test("startFrame matches the typed chat message", () => {
  assert.deepEqual(JSON.parse(startFrame("hi")), { type: "start", prompt: "hi" });
  assert.deepEqual(JSON.parse(startFrame(null)), { type: "start" });
});
