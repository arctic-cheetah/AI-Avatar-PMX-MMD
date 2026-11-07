# Voice volume and peak protection

The renderer's **Chat → Voice volume** slider sets listening gain from **−24 dB
to +18 dB**, in 1 dB steps. **0 dB** is the default and **Reset voice volume**
returns to it. Start with +6 dB when speech is too quiet.

The setting is saved in this browser's local storage (`yidhari.voice-volume-db`),
including changes made before the first clip. It is shared by samples, chat,
fillers and MCP `say`, `report` and `ask` speech because all use the same
`SpeechPlayer`. It is per browser origin/profile, not a bridge or system-volume
setting. Storage denial leaves the control usable for the current session.
Changing it during speech takes effect without restarting anything. The control
stays available while the other test-bench controls are locked during a reply.

## Signal path and limits

```text
Kokoro → RVC → existing trim → alignment → decoded clip
    → listening gain → linked stereo lookahead limiter → speakers
```

Kokoro's samples, conversion settings, converted files and viseme tracks are
unchanged. The slider changes playback only, so it also applies to Edge → RVC.
The new stage requires AudioWorklet; serve on localhost (or HTTPS) in a current
browser. A worklet load failure is surfaced through the existing speech error
status, without falling back to unprotected amplified output.

Gain changes use an AudioParam exponential approach with a 15 ms time constant
(about 45 ms to reach 95% of the change). Retargeting holds the current value,
including when the slider moves repeatedly. The limiter anticipates transients
by 5 ms, with a linear attack envelope and an 80 ms release time constant. Both
channels share gain reduction to preserve stereo balance. It limits sample peaks
to **−1 dBFS**; it is not a certified true-peak limiter. Reconstructed analogue
peaks may be higher than sample peaks.

The player compensates for the lookahead in its audio-clock lip-sync timing and
pads each playback buffer with just enough silence to flush the delayed tail
before advancing the queue. It does not change speech duration or playback rate.
Stop clears delayed sound and gain reduction before the next clip.

This is manual gain, not automatic loudness normalisation. Silence stays zero,
and there is no automatic makeup gain that raises quiet gaps. Existing trimming
still removes unwanted RVC tails. Residual noise already inside a clip rises with
the requested volume; no new noise gate removes soft consonants. Below the
ceiling, 0 dB is sample-transparent apart from the compensated delay. Peaks above
the ceiling are protected even at 0 dB.

High boosts cannot supply their full requested gain on already loud audio: the
limiter reduces peaks. Sustained limiting can sound compressed or pump, especially
at +12 to +18 dB. Reduce the slider if this affects voice quality. Protection does
not repair distortion already present in the input or guarantee hardware volume.

## Measurements — 7 November 2026

Two new sentences were synthesised with the existing local Kokoro 0.6.1
`af_heart`, speed 1, 2 threads, then converted using the existing Yidhari
`75e_21450s` RVC checkpoint with default conversion settings and 4 CPU threads.
Final clips were trimmed with the existing source-based trimmer. No source gain
or model changes were applied. The source and converted clips were decoded at
48 kHz and measured through Chromium's actual OfflineAudioContext/AudioWorklet
path. RMS is over the whole measured clip, including retained pauses; these
numbers are dBFS, not LUFS or acoustic loudness measurements.

Sentences:

- Greeting: “Good evening! I am ready to keep you company.”
- Emphatic: “Stop! Check the logs, protect the keys, and keep our systems safe!”

| Clip / stage | Duration | Peak dBFS | RMS dBFS |
| --- | ---: | ---: | ---: |
| Greeting, Kokoro source | 3.000 s | −5.15 | −25.28 |
| Greeting, final RVC, 0 dB | 2.510 s | −1.86 | −15.08 |
| Greeting, final RVC, +6 dB | 2.510 s | −1.00 | −11.33 |
| Greeting, final RVC, +12 dB | 2.510 s | −1.00 | −10.11 |
| Greeting, final RVC, +18 dB | 2.510 s | −1.00 | −9.25 |
| Emphatic, Kokoro source | 4.720 s | −7.27 | −25.56 |
| Emphatic, final RVC, 0 dB | 4.230 s | −1.60 | −17.13 |
| Emphatic, final RVC, +6 dB | 4.230 s | −1.00 | −13.27 |
| Emphatic, final RVC, +12 dB | 4.230 s | −1.00 | −11.67 |
| Emphatic, final RVC, +18 dB | 4.230 s | −1.00 | −10.63 |

All boosted outputs had **zero samples at or beyond full scale**. An additional
ffmpeg 4× oversampling check of the limiter's rendered final clips found peaks
between −0.91 and −0.26 dBFS at +6/+12/+18 dB. This checks these clips, not every
possible input. The source/final comparison shows no level loss in these two
conversions; differing trim durations contribute to the RMS difference. It does
not identify the cause of the user's quiet-headset experience.

At +6 dB the final clips gained 3.75 and 3.86 dB RMS. This supports a meaningful
listening increase without changing conversion input. The larger settings show
diminishing average-level gains as limiting becomes stronger.

## Repeatable checks and remaining listening validation

```bash
npm ci --ignore-scripts
node --test tests/renderer/*.test.mjs
.venv/bin/python -m unittest discover -s tests -v
```

The new playback tests were run red first: direct-output routing and late
playback after cancellation failed on the original player. They pass with the
protected route, delayed-tail flush and generation check. Limiter tests cover
transients, exact quiet gain, silence, stereo linking, reset and multiple sample
rates; volume tests cover persistence, storage denial, smoothing and failed or
concurrent module loads.

For actual browser DSP checks, serve the repository, open the renderer and run
in the browser console (no audio is sent to speakers):

```js
const qa = await import('/tests/renderer/voice-volume-browser.js');
await qa.checkVoiceVolume();
// Measure an existing local speech clip before/after the protected gain stage:
await qa.measureClips(['/assets/private/speech/sample-01.wav']);
```

The browser check passed 20 signal/rate/gain cases at 24, 44.1, 48 and 96 kHz,
plus a live −24 → +18 dB transition whose largest sample step was 0.000219 on a
quiet constant signal. Browser interaction also verified +6 dB restoration after
reload, reset to 0 dB, and actual sample playback through an AudioWorkletNode.

At this branch's starting commit, the Python suite has an unrelated existing
failure in `SummariserTests.test_prompt_rules_and_secret_free_input`: it expects
“3” in a prompt that now allows 1–10 sentences. The failure was reproduced in
an untouched archive of the starting commit. It is outside this volume change.

Human listening validation remains required: compare quiet and emphatic speech
at 0, +6 and +12 dB on the user's headset; move the slider during speech; listen
for clicks, pumping, background breath and changed character; inspect soft word
endings and mouth timing. Check chat plus MCP `say`, `report` and `ask` playback,
then reload and reset. Automated peak/timing results do not establish subjective
voice quality or adequate headset loudness. Keep issue #55 open until this check
is accepted.
