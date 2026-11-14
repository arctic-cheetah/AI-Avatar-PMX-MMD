import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument } from "./fake-dom.mjs";
import { CameraControls, CAMERA_DEVICE_KEY } from "../../renderer/camera-controls.js";

const device = (id, label = "") => ({ kind: "videoinput", deviceId: id, label });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(t, { saved = "", storageBlocked = false, available = true, mediaSupported = true, canEnumerate = true } = {}) {
  const document = createDocument();
  const toggle = document.createElement("input"), select = document.createElement("select");
  const refresh = document.createElement("button"), status = document.createElement("p");
  const choices = [], enabled = [], stored = new Map(saved ? [[CAMERA_DEVICE_KEY, saved]] : []);
  const camera = { running: false, activeDeviceId: "", stops: 0,
    async start(id) { choices.push(id); this.running = true; this.activeDeviceId = id || "built-in"; return true; },
    stop() { this.stops++; this.running = false; this.activeDeviceId = ""; },
  };
  const mediaDevices = new EventTarget();
  Object.assign(mediaDevices, { devices: [device("built-in", "Built-in"), device("usb", "USB camera")],
    async enumerateDevices() { return this.devices; }, getUserMedia() { throw new Error("enumeration must not capture"); } });
  const local = {
    getItem(key) { if (storageBlocked) throw new Error("blocked"); return stored.get(key); },
    setItem(key, value) { if (storageBlocked) throw new Error("blocked"); stored.set(key, value); },
  };
  if (!mediaSupported) delete mediaDevices.getUserMedia;
  if (!canEnumerate) delete mediaDevices.enumerateDevices;
  const controls = new CameraControls({ camera, toggle, select, refresh, status, mediaDevices, local,
    available, onEnabled: (value) => enabled.push(value) });
  t.after(() => controls.dispose());
  return { controls, camera, toggle, select, refresh, status, mediaDevices, choices, stored, enabled };
}

test("lists only video inputs with safe text labels, without starting capture", async (t) => {
  const f = fixture(t);
  f.mediaDevices.devices.push({ kind: "audioinput", deviceId: "mic", label: "Microphone" });
  f.mediaDevices.devices[1].label = "USB <camera>";
  await f.controls.ready;
  assert.deepEqual(f.select.children.map((o) => o.textContent), ["System default camera", "Built-in", "USB <camera>"]);
  assert.deepEqual(f.choices, []);
  assert.equal(f.toggle.checked, false);
});

test("saved preference is restored but does not enable tracking", async (t) => {
  const f = fixture(t, { saved: "usb" });
  await f.controls.ready;
  assert.equal(f.select.value, "usb");
  assert.deepEqual(f.choices, []);
  assert.equal(f.toggle.checked, false);
});

test("selection while off persists without capture, then the toggle uses it", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  f.select.value = "usb";
  f.select.emit("change");
  await settle();
  assert.equal(f.stored.get(CAMERA_DEVICE_KEY), "usb");
  assert.deepEqual(f.choices, []);
  f.toggle.checked = true;
  f.toggle.emit("change");
  await settle();
  assert.deepEqual(f.choices, ["usb"]);
  assert.equal(f.enabled.at(-1), true);
  assert.match(f.status.textContent, /processed locally/i);
});

test("selecting another camera while active switches without a reload", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  await f.controls.setTracking(true);
  await f.controls.choose("usb");
  assert.deepEqual(f.choices, ["", "usb"]);
  assert.equal(f.toggle.checked, true);
  assert.equal(f.select.value, "usb");
});

test("empty preference explicitly returns to the system default", async (t) => {
  const f = fixture(t, { saved: "usb" });
  await f.controls.ready;
  await f.controls.choose("");
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, [""]);
  assert.equal(f.stored.get(CAMERA_DEVICE_KEY), "");
});

test("missing saved camera stays explicit rather than silently selecting a different one", async (t) => {
  const f = fixture(t, { saved: "missing" });
  await f.controls.ready;
  assert.equal(f.select.value, "missing");
  assert.match(f.select.children.at(-1).textContent, /not listed/i);
  assert.match(f.status.textContent, /not listed.*another camera/i);
  assert.deepEqual(f.choices, []);
});

test("unnamed or permission-hidden inputs have labels and default remains usable", async (t) => {
  const f = fixture(t);
  f.mediaDevices.devices = [device("", "")];
  await f.controls.ready;
  await f.controls.refresh(true);
  assert.match(f.select.children[1].textContent, /Camera 1/);
  assert.equal(f.select.children[1].disabled, true);
  assert.equal(f.toggle.disabled, false);
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, [""]);
});

test("refresh and devicechange update the list without capturing", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  f.mediaDevices.devices = [device("new", "New camera")];
  f.mediaDevices.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.equal(f.select.children[1].textContent, "New camera");
  f.mediaDevices.devices = [];
  f.refresh.emit("click");
  await settle();
  assert.match(f.status.textContent, /no cameras listed/i);
  assert.equal(f.toggle.disabled, false, "enumeration can be permission-filtered");
  assert.deepEqual(f.choices, []);
});

test("successful capture refreshes labels exposed by permission", async (t) => {
  const f = fixture(t);
  f.mediaDevices.devices = [device("usb")];
  await f.controls.ready;
  f.camera.start = async () => {
    f.camera.running = true; f.camera.activeDeviceId = "usb";
    f.mediaDevices.devices = [device("usb", "USB camera")];
    return true;
  };
  await f.controls.setTracking(true);
  await settle();
  assert.equal(f.select.children[1].textContent, "USB camera");
});

test("camera failure resets tracking and keeps another camera selectable", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  f.camera.start = async () => { throw new Error("Camera busy · select another camera."); };
  await f.controls.setTracking(true);
  assert.equal(f.toggle.checked, false);
  assert.equal(f.enabled.at(-1), false);
  assert.match(f.status.textContent, /busy/);
  assert.equal(f.select.disabled, false);
});

test("turning off while startup is pending prevents stale success status", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  let finish;
  f.camera.start = () => new Promise((resolve) => { finish = resolve; });
  const starting = f.controls.setTracking(true);
  await f.controls.setTracking(false);
  finish(true);
  await starting;
  assert.equal(f.toggle.checked, false);
  assert.equal(f.enabled.at(-1), false);
  assert.equal(f.status.textContent, "");
});

test("late enumeration does not replace a current camera error", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  let finish;
  f.mediaDevices.enumerateDevices = () => new Promise((resolve) => { finish = resolve; });
  const listing = f.controls.refresh(true);
  f.camera.start = async () => { throw new Error("Camera permission denied"); };
  await f.controls.setTracking(true);
  finish([]);
  await listing;
  assert.match(f.status.textContent, /permission denied/);
});

test("disconnected active camera stops and offers manual recovery, without auto-restarting", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  await f.controls.setTracking(true);
  f.mediaDevices.devices = [device("usb", "USB camera")];
  await f.controls.refresh(true);
  assert.equal(f.camera.running, false);
  assert.equal(f.toggle.checked, false);
  assert.match(f.status.textContent, /disconnected.*another camera/i);
  assert.deepEqual(f.choices, [""]);
});

test("track-ended notification clears tracking and gaze immediately", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  await f.controls.setTracking(true);
  f.camera.onEnded("Camera disconnected · select another camera.");
  assert.equal(f.toggle.checked, false);
  assert.equal(f.enabled.at(-1), false);
  assert.match(f.status.textContent, /disconnected/);
});

test("blocked storage does not block selection or capture", async (t) => {
  const f = fixture(t, { storageBlocked: true });
  await f.controls.ready;
  await f.controls.choose("usb");
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, ["usb"]);
});

test("failed enumeration offers refresh but does not disable the opt-in default", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  f.mediaDevices.enumerateDevices = async () => { throw new Error("browser failed"); };
  await f.controls.refresh(true);
  assert.match(f.status.textContent, /could not list.*refresh/i);
  assert.equal(f.toggle.disabled, false);
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, [""]);
});

test("model without eye bones disables tracking, while selection stays capture-free", async (t) => {
  const f = fixture(t, { available: false });
  await f.controls.ready;
  await f.controls.setTracking(true);
  assert.equal(f.toggle.disabled, true);
  assert.deepEqual(f.choices, []);
  f.controls.setAvailable(true);
  assert.equal(f.toggle.disabled, false);
});

test("without enumeration a saved device can still be changed back to default", async (t) => {
  const f = fixture(t, { canEnumerate: false, saved: "missing" });
  await f.controls.ready;
  assert.equal(f.select.disabled, false);
  assert.equal(f.refresh.disabled, true);
  await f.controls.choose("");
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, [""]);
});

test("missing camera API gives a secure-context hint and cannot start capture", async (t) => {
  const f = fixture(t, { mediaSupported: false });
  await f.controls.ready;
  assert.equal(f.toggle.disabled, true);
  assert.match(f.status.textContent, /HTTPS or localhost/);
  await f.controls.setTracking(true);
  assert.deepEqual(f.choices, []);
});

test("a stale switch failure cannot uncheck a newer successful camera", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  let reject;
  f.camera.start = () => new Promise((_, fail) => { reject = fail; });
  const first = f.controls.setTracking(true);
  f.camera.start = async () => true;
  await f.controls.choose("usb");
  reject(new Error("Camera busy"));
  await first;
  assert.equal(f.toggle.checked, true);
  assert.equal(f.enabled.at(-1), true);
  assert.match(f.status.textContent, /Camera on/);
});

test("disposal ignores late enumeration and stops tracking", async (t) => {
  const f = fixture(t);
  await f.controls.ready;
  let finish;
  f.mediaDevices.enumerateDevices = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.controls.refresh(true);
  f.controls.dispose();
  finish([]);
  await pending;
  assert.equal(f.status.textContent, "");
  assert.equal(f.toggle.checked, false);
  assert.equal(f.camera.running, false);
});
