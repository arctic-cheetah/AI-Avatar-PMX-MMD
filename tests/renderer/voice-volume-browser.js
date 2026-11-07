/**
 * Real AudioWorklet checks, with no speakers or extra test dependencies.
 * Serve the repository, open the renderer, then in the browser console:
 *   const qa = await import('/tests/renderer/voice-volume-browser.js');
 *   await qa.checkVoiceVolume();
 * Optional: await qa.measureClips(['/assets/private/speech/sample-01.wav']);
 */
import { VoiceVolume } from '../../renderer/voice-volume.js';
import { LOOKAHEAD_SECONDS, PEAK_CEILING } from '../../renderer/voice-limiter.js';

function check(condition, message) { if (!condition) throw new Error(message); }
const memoryStorage = { getItem: () => null, setItem() {} };

function levels(samples) {
  let peak = 0, energy = 0, clipped = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
    if (Math.abs(sample) >= 1) clipped++;
  }
  return { peakDbfs: 20 * Math.log10(peak), rmsDbfs: 10 * Math.log10(energy / samples.length), clipped };
}

async function render(buffer, db, change = false) {
  const delay = Math.ceil(buffer.sampleRate * LOOKAHEAD_SECONDS);
  const context = new OfflineAudioContext(2, buffer.length + delay, buffer.sampleRate);
  const volume = new VoiceVolume(memoryStorage);
  volume.setDb(db);
  const node = await volume.connect(context);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(node);
  source.start();
  if (change) {
    // Exercise the exact live retargeting method halfway through rendering.
    const suspended = context.suspend(0.5).then(async () => { volume.setDb(18); await context.resume(); });
    const rendered = await context.startRendering();
    await suspended;
    return rendered;
  }
  return context.startRendering();
}

export async function checkVoiceVolume() {
  const results = [];
  for (const rate of [24000, 44100, 48000, 96000]) {
    const context = new OfflineAudioContext(1, rate, rate);
    const quiet = context.createBuffer(1, rate, rate);
    const signal = quiet.getChannelData(0);
    for (let i = 0; i < signal.length; i++) signal[i] = i < 1000 ? 0 : 0.02 * Math.sin(i * 0.1);
    for (const db of [-24, 0, 6, 18]) {
      const output = await render(quiet, db);
      const samples = output.getChannelData(0);
      const delay = Math.ceil(rate * LOOKAHEAD_SECONDS);
      const gain = 10 ** (db / 20);
      check(samples.slice(0, delay + 1000).every(s => s === 0), 'Silence changed');
      for (let i = 0; i < signal.length; i++) {
        check(Math.abs(samples[i + delay] - signal[i] * gain) < 1e-6, `Quiet gain/timing changed at ${rate} Hz`);
      }
      results.push({ rate, db, ...levels(samples) });
    }
    const loud = context.createBuffer(1, rate, rate);
    for (let i = 0; i < rate; i++) loud.getChannelData(0)[i] = Math.sin(i * 0.07);
    const output = await render(loud, 18);
    const measurement = levels(output.getChannelData(0));
    check(measurement.clipped === 0 && measurement.peakDbfs <= -0.99999, 'Peak ceiling exceeded');
    results.push({ rate, db: 18, signal: 'loud', ...measurement });
  }
  const context = new OfflineAudioContext(1, 48000, 48000);
  const quiet = context.createBuffer(1, 48000, 48000);
  quiet.getChannelData(0).fill(0.02);
  const changed = (await render(quiet, -24, true)).getChannelData(0);
  const start = Math.ceil(48000 * LOOKAHEAD_SECONDS) + 100;
  let maximumStep = 0;
  for (let i = start; i < changed.length; i++) maximumStep = Math.max(maximumStep, Math.abs(changed[i] - changed[i - 1]));
  check(maximumStep < 0.001, 'Live volume change has a sample discontinuity');
  return { passed: true, cases: results.length, liveChangeMaximumStep: maximumStep,
    ceiling: PEAK_CEILING, results };
}

export async function measureClips(urls) {
  const results = [];
  for (const url of urls) {
    const decoder = new OfflineAudioContext(1, 1, 48000);
    const response = await fetch(url);
    check(response.ok, `Clip unavailable: ${url}`);
    const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
    const delay = Math.ceil(buffer.sampleRate * LOOKAHEAD_SECONDS);
    const sourceLevels = levels(buffer.getChannelData(0));
    for (const db of [0, 6, 12, 18]) {
      const output = await render(buffer, db);
      const samples = output.getChannelData(0).subarray(delay, delay + buffer.length);
      const measurement = levels(samples);
      check(measurement.clipped === 0 && measurement.peakDbfs <= -0.99999, 'Peak ceiling exceeded');
      results.push({ url, requestedDb: db, source: sourceLevels, output: measurement,
        durationSeconds: buffer.duration, measuredFrames: samples.length });
    }
  }
  return results;
}
