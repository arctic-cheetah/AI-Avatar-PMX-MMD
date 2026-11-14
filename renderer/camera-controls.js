// Camera choice is persistent; capture is deliberately never persistent (#53).
export const CAMERA_DEVICE_KEY = "yidhari.cameraDevice";

export class CameraControls {
  constructor({ camera, toggle, select, refresh, status, onEnabled,
    mediaDevices = globalThis.navigator?.mediaDevices, local, available = false }) {
    Object.assign(this, { camera, toggle, select, refreshButton: refresh, status, onEnabled, mediaDevices, available });
    this.operation = 0;
    this.listVersion = 0;
    this.disposed = false;
    this.preferred = "";
    try {
      this.local = local ?? globalThis.localStorage;
      this.preferred = this.local?.getItem(CAMERA_DEVICE_KEY) || "";
    } catch { /* Storage may be blocked; a session-only choice still works. */ }
    toggle.checked = false;
    this.onToggle = () => { void this.setTracking(toggle.checked); };
    this.onSelect = () => { void this.choose(select.value); };
    this.onRefresh = () => { void this.refresh(true); };
    toggle.addEventListener("change", this.onToggle);
    select.addEventListener("change", this.onSelect);
    refresh.addEventListener("click", this.onRefresh);
    mediaDevices?.addEventListener?.("devicechange", this.onRefresh);
    camera.onEnded = (message) => this.interrupted(message);
    this.renderDevices([]);
    this.updateAvailability();
    this.ready = this.refresh(true);
  }

  updateAvailability() {
    const supported = Boolean(this.mediaDevices?.getUserMedia);
    this.toggle.disabled = !this.available || !supported;
    this.select.disabled = !supported;
    this.refreshButton.disabled = !supported || !this.mediaDevices?.enumerateDevices;
    if (!supported) this.status.textContent = "Camera not available · use HTTPS or localhost in a supported browser.";
  }

  setAvailable(available) {
    this.available = available;
    if (!available) this.interrupted("This model has no eye bones, so gaze tracking is unavailable.");
    this.updateAvailability();
  }

  renderDevices(devices) {
    const option = (value, label, disabled = false) => {
      const node = this.select.ownerDocument.createElement("option");
      node.value = value;
      node.textContent = label;
      node.disabled = disabled;
      return node;
    };
    const choices = devices.map((device, index) => option(device.deviceId,
      device.label || `Camera ${index + 1} · enable tracking to reveal names`, !device.deviceId));
    const missing = this.preferred && !devices.some((device) => device.deviceId === this.preferred);
    if (missing) choices.push(option(this.preferred, "Saved camera (not listed)"));
    this.select.replaceChildren(option("", "System default camera"), ...choices);
    this.select.value = this.preferred;
    return missing;
  }

  /** Enumeration never prompts for permission or requests a stream. */
  async refresh(announce = false) {
    if (!this.mediaDevices?.getUserMedia || !this.mediaDevices?.enumerateDevices || this.disposed) return;
    const version = ++this.listVersion, operation = this.operation;
    try {
      const devices = (await this.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
      if (version !== this.listVersion || this.disposed) return;
      const missing = this.renderDevices(devices);
      // Do not apply a list from before a switch to the new stream.
      if (operation !== this.operation) return;
      const active = this.camera.activeDeviceId;
      if (this.camera.running && active && !devices.some((device) => device.deviceId === active)) {
        this.interrupted("Camera disconnected · select another camera and enable tracking again.");
      } else if (announce && !this.toggle.checked && this.available) {
        this.status.textContent = missing
          ? "Saved camera not listed · it may be disconnected or hidden until permission is granted. Select another camera or enable tracking to try it."
          : devices.length ? "Camera capture is off · enable tracking to use the selected camera."
            : "No cameras listed · connect a camera and refresh, or enable tracking to request permission.";
      }
    } catch {
      if (version === this.listVersion && operation === this.operation && announce && !this.toggle.checked && this.available && !this.disposed) {
        this.status.textContent = "Could not list cameras · refresh to retry, or enable tracking to try the selected camera.";
      }
    }
  }

  async choose(deviceId) {
    if (this.disposed) return;
    this.preferred = deviceId;
    this.select.value = deviceId;
    try { this.local?.setItem(CAMERA_DEVICE_KEY, deviceId); } catch { /* Session-only preference. */ }
    if (this.toggle.checked) await this.setTracking(true);
    else if (this.available) this.status.textContent = "Camera capture is off · enable tracking to use the selected camera.";
  }

  /** Start only on a toggle click, or a selection change while already on. */
  async setTracking(enabled) {
    if (this.disposed) return;
    if (enabled && this.toggle.disabled) return;
    const operation = ++this.operation;
    this.toggle.checked = Boolean(enabled && !this.toggle.disabled);
    this.onEnabled(false);
    if (!this.toggle.checked) {
      this.camera.stop();
      this.status.textContent = "";
      return;
    }
    this.status.textContent = "Starting camera…";
    try {
      const started = await this.camera.start(this.preferred);
      if (operation !== this.operation || this.disposed) return;
      if (!started) {
        this.interrupted("Camera stopped · enable tracking to try again.");
        return;
      }
      this.onEnabled(true);
      this.status.textContent = "Camera on · processed locally, nothing is recorded or sent.";
      void this.refresh(); // Permission may have revealed device names/IDs.
    } catch (error) {
      if (operation === this.operation && !this.disposed) this.interrupted(error.message);
    }
  }

  interrupted(message) {
    this.operation++;
    this.camera.stop();
    this.toggle.checked = false;
    this.onEnabled(false);
    this.status.textContent = message;
  }

  dispose() {
    this.interrupted("");
    this.disposed = true;
    this.listVersion++;
    this.toggle.removeEventListener("change", this.onToggle);
    this.select.removeEventListener("change", this.onSelect);
    this.refreshButton.removeEventListener("click", this.onRefresh);
    this.mediaDevices?.removeEventListener?.("devicechange", this.onRefresh);
  }
}
