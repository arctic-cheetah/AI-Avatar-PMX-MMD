import { test } from "node:test";
import assert from "node:assert/strict";
import { CameraGaze } from "../../renderer/camera-gaze.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function stream(id) {
  const track = new EventTarget();
  Object.assign(track, { stops: 0, stop() { this.stops++; }, getSettings: () => ({ deviceId: id }) });
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function fixture(t, overrides = {}) {
  const requests = [], videos = [], frames = new Map(), ended = [];
  let next = 0;
  const mediaDevices = { async getUserMedia(constraints) { requests.push(constraints); return stream("usb"); } };
  const createVideo = () => {
    const video = { currentTime: 0, srcObject: null, async play() {}, pause() {} };
    videos.push(video);
    return video;
  };
  const tracker = { detectForVideo: () => ({ faceLandmarks: [] }) };
  // Install browser globals as well: these make the pre-change adapter executable
  // so the red run fails on behaviour, rather than on a missing browser API.
  const restore = [];
  for (const [key, value] of Object.entries({ navigator: { mediaDevices }, document: { createElement: createVideo },
    requestAnimationFrame: (fn) => { frames.set(++next, fn); return next; },
    cancelAnimationFrame: (id) => frames.delete(id) })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => before ? Object.defineProperty(globalThis, key, before) : delete globalThis[key]);
  }
  const camera = new CameraGaze(() => {}, { mediaDevices, createVideo, loadLandmarker: async () => tracker,
    onEnded: (message) => ended.push(message), ...overrides });
  camera.landmarker = tracker;
  t.after(() => { camera.stop(); restore.forEach((fn) => fn()); });
  return { camera, mediaDevices, requests, videos, frames, ended, tracker };
}

test("requests the selected camera exactly, without microphone capture", async (t) => {
  const { camera, requests } = fixture(t);
  await camera.start("usb");
  assert.deepEqual(requests[0].video.deviceId, { exact: "usb" });
  assert.equal(requests[0].audio, false);
  assert.equal(requests[0].video.facingMode, undefined);
  assert.equal(camera.activeDeviceId, "usb");
});

test("system default still uses the user-facing preference", async (t) => {
  const { camera, requests } = fixture(t);
  await camera.start();
  assert.equal(requests[0].video.deviceId, undefined);
  assert.equal(requests[0].video.facingMode, "user");
});

test("switch releases old tracks before opening the next camera", async (t) => {
  const { camera, mediaDevices } = fixture(t);
  await camera.start("first");
  const old = camera.stream;
  mediaDevices.getUserMedia = async () => {
    assert.equal(old.track.stops, 1);
    return stream("second");
  };
  await camera.start("second");
  assert.equal(camera.activeDeviceId, "second");
});

test("stop during a permission prompt releases the late stream and starts no loop", async (t) => {
  const { camera, mediaDevices, videos, frames } = fixture(t);
  const pending = deferred(), late = stream("late");
  mediaDevices.getUserMedia = () => pending.promise;
  const starting = camera.start("late");
  camera.stop();
  pending.resolve(late);
  await starting;
  assert.equal(late.track.stops, 1);
  assert.equal(camera.running, false);
  assert.equal(videos.length, 0);
  assert.equal(frames.size, 0);
});

test("out-of-order requests cannot replace the latest camera", async (t) => {
  const { camera, mediaDevices } = fixture(t);
  const first = deferred(), second = deferred(), old = stream("old"), latest = stream("latest");
  const pending = [first, second];
  mediaDevices.getUserMedia = () => pending.shift().promise;
  const a = camera.start("old"), b = camera.start("latest");
  second.resolve(latest);
  await b;
  first.resolve(old);
  await a;
  assert.equal(camera.stream, latest);
  assert.equal(old.track.stops, 1);
  assert.equal(latest.track.stops, 0);
});

test("a stale rejection cannot stop the latest camera", async (t) => {
  const { camera, mediaDevices } = fixture(t);
  const pending = deferred();
  mediaDevices.getUserMedia = () => pending.promise;
  const old = camera.start("old");
  mediaDevices.getUserMedia = async () => stream("latest");
  await camera.start("latest");
  pending.reject(new DOMException("denied", "NotAllowedError"));
  await old;
  assert.equal(camera.activeDeviceId, "latest");
  assert.equal(camera.stream.track.stops, 0);
});

test("playback failure releases the acquired stream", async (t) => {
  const { camera, mediaDevices } = fixture(t, { createVideo: () => ({
    srcObject: null, pause() {}, async play() { throw new Error("play failed"); },
  }) });
  const acquired = stream("usb");
  mediaDevices.getUserMedia = async () => acquired;
  await assert.rejects(camera.start("usb"), /video|camera/i);
  assert.equal(acquired.track.stops, 1);
  assert.equal(camera.running, false);
});

test("tracker load failure releases capture and offers retry", async (t) => {
  const { camera, mediaDevices } = fixture(t, { loadLandmarker: async () => { throw new Error("offline"); } });
  camera.landmarker = null;
  const acquired = stream("usb");
  mediaDevices.getUserMedia = async () => acquired;
  await assert.rejects(camera.start("usb"), /face tracker.*try again/i);
  assert.equal(acquired.track.stops, 1);
});

test("stop during video startup cannot revive the detection loop", async (t) => {
  const playback = deferred();
  const { camera, frames } = fixture(t, { createVideo: () => ({ srcObject: null, play: () => playback.promise, pause() {} }) });
  const starting = camera.start("usb");
  await settle();
  camera.stop();
  playback.resolve();
  await starting;
  assert.equal(camera.running, false);
  assert.equal(frames.size, 0);
});

test("stop during tracker loading does not revive capture; a later start reuses the tracker", async (t) => {
  const loading = deferred();
  let loads = 0;
  const { camera, tracker, frames } = fixture(t, { loadLandmarker: () => { loads++; return loading.promise; } });
  camera.landmarker = null;
  const starting = camera.start("usb");
  await settle();
  camera.stop();
  loading.resolve(tracker);
  await starting;
  assert.equal(frames.size, 0);
  await camera.start("usb");
  assert.equal(loads, 1);
  assert.equal(camera.running, true);
});

test("a disconnected track stops detection and reports recovery", async (t) => {
  const { camera, frames, ended } = fixture(t);
  await camera.start("usb");
  const acquired = camera.stream;
  acquired.track.dispatchEvent(new Event("ended"));
  assert.equal(camera.running, false);
  assert.equal(acquired.track.stops, 1);
  assert.equal(frames.size, 0);
  assert.match(ended[0], /disconnected.*another camera/i);
});

test("tracker download failure can be retried successfully", async (t) => {
  let attempts = 0;
  const tracker = { detectForVideo: () => ({ faceLandmarks: [] }) };
  const { camera } = fixture(t, { loadLandmarker: async () => {
    if (++attempts === 1) throw new Error("offline");
    return tracker;
  } });
  camera.landmarker = null;
  await assert.rejects(camera.start(), /face tracker/);
  await camera.start();
  assert.equal(camera.running, true);
  assert.equal(attempts, 2);
});

test("switching cameras preserves the floating window's frame source", async (t) => {
  const { camera, frames } = fixture(t);
  const floating = new Map();
  camera.useFrames({ requestAnimationFrame: (fn) => { floating.set(1, fn); return 1; },
    cancelAnimationFrame: (id) => floating.delete(id) });
  await camera.start("first");
  await camera.start("second");
  assert.equal(frames.size, 0);
  assert.equal(floating.size, 1);
  camera.stop();
  assert.equal(floating.size, 0);
});

for (const [name, message] of [
  ["NotAllowedError", /permission denied/i], ["NotFoundError", /no camera|not found/i],
  ["NotReadableError", /busy|unavailable/i], ["OverconstrainedError", /selected camera.*unavailable/i],
]) {
  test(`${name} gets an actionable camera error`, async (t) => {
    const { camera, mediaDevices } = fixture(t);
    mediaDevices.getUserMedia = async () => { throw new DOMException("browser details", name); };
    await assert.rejects(camera.start("usb"), message);
    assert.equal(camera.running, false);
  });
}
