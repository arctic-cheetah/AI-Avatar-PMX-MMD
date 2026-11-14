// Browser-only webcam adapter for gaze tracking (issue #6).
// The camera starts only from the toggle click that calls start(), frames
// are reduced locally to a normalised target, and stop() releases all
// tracks. Nothing is recorded or sent anywhere.

import { FrameLoop } from "./pop-out.js";

const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function loadLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL }, runningMode: "VIDEO", numFaces: 1,
  });
}

function cameraError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission denied · allow camera access in the browser, then try again.";
    case "NotFoundError":
      return "No camera found · connect a camera, refresh the list and select another camera.";
    case "OverconstrainedError":
      return "Selected camera unavailable · refresh the list and select another camera.";
    default:
      return "Camera busy or unavailable · close other camera apps or select another camera.";
  }
}

export class CameraGaze {
  /**
   * @param {(target:{x:number,y:number})=>void} onTarget Fresh face target callback.
   */
  constructor(onTarget, {
    mediaDevices = globalThis.navigator?.mediaDevices,
    createVideo = () => document.createElement("video"),
    loadLandmarker: load = loadLandmarker,
    onEnded = () => {},
  } = {}) {
    this.onTarget = onTarget;
    Object.assign(this, { mediaDevices, createVideo, loadLandmarker: load, onEnded });
    this.generation = 0;
    this.loading = null;
    this.stream = null;
    this.video = null;
    this.landmarker = null;
    this.lastVideoTime = -1;
    /** @type {FrameLoop | null} */
    this.loop = null;
    /** Window whose frames drive detection; the floating window while popped out. */
    this.frames = globalThis;
  }

  /**
   * Run detection on another window's frames, so it keeps going while the
   * main tab is hidden behind the pop-out window.
   * @param {Window} view Window that now shows the avatar.
   * @returns {void}
   */
  useFrames(view) {
    this.frames = view;
    this.loop?.use(view);
  }

  /** @returns {boolean} Whether the camera is currently running. */
  get running() {
    return Boolean(this.stream);
  }

  /** The browser's actual device ID, also for system-default capture. */
  get activeDeviceId() {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
  }

  /**
   * Start the webcam and per-frame face detection.
   * Release the previous camera first. Only the newest request may publish a
   * stream or detection loop; permission prompts cannot be cancelled by JS.
   * @param {string} [deviceId] Empty uses the system's user-facing default.
   * @returns {Promise<boolean>} False if superseded/stopped; rejects on failure.
   */
  async start(deviceId = "") {
    this.stop();
    const generation = this.generation;
    if (!this.mediaDevices?.getUserMedia) throw new Error("Camera not available · use HTTPS or localhost in a supported browser.");
    let failure = "";
    try {
      const stream = await this.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }) },
        audio: false,
      });
      if (generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (generation !== this.generation) return;
          this.stop();
          this.onEnded("Camera disconnected or stopped · select another camera and enable tracking again.");
        }, { once: true });
      }
      failure = "Could not play the camera video · select another camera or try again.";
      const video = this.createVideo();
      this.video = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (generation !== this.generation) return false;
      failure = "Could not load the face tracker. Check your connection and try again.";
      if (!this.landmarker) {
        // Share loading across a switch; a failed download can be retried.
        this.loading ??= this.loadLandmarker().then((tracker) => {
          this.landmarker = tracker;
        }).finally(() => {
          this.loading = null;
        });
        await this.loading;
      }
      if (generation !== this.generation) return false;
      const tick = () => {
        if (generation !== this.generation) return;
        if (video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = video.currentTime;
          const result = this.landmarker.detectForVideo(video, performance.now());
          const landmarks = result?.faceLandmarks?.[0];
          if (landmarks?.length) this.onTarget(faceTarget(landmarks));
        }
      };
      failure = "Camera tracking failed · turn tracking on to try again or select another camera.";
      this.loop = new FrameLoop(tick, this.frames);
      this.loop.start();
      tick();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw new Error(failure || cameraError(error));
    }
  }

  /**
   * Stop detection and release the webcam immediately.
   * @returns {void}
   */
  stop() {
    this.generation++;
    this.loop?.stop();
    this.loop = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
    this.lastVideoTime = -1;
  }
}

/**
 * Reduce face landmarks to a normalised gaze target.
 * Nose-tip position in the (mirrored selfie) frame approximates where the
 * face sits/turns: moving/turning right should make Yidhari look right,
 * so x is mirrored back out of selfie space.
 * @param {{x:number,y:number}[]} landmarks MediaPipe normalised landmarks.
 * @returns {{x:number,y:number}} Target in -1..1.
 */
export function faceTarget(landmarks) {
  const nose = landmarks[1] ?? landmarks[4] ?? { x: 0.5, y: 0.5 };
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  return { x: clamp(-((nose.x - 0.5) * 3)), y: clamp((nose.y - 0.5) * 3) };
}
