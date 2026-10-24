// Browser-only webcam adapter for gaze tracking (issue #6).
// The camera starts only from the toggle click that calls start(), frames
// are reduced locally to a normalised target, and stop() releases all
// tracks. Nothing is recorded or sent anywhere.

const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export class CameraGaze {
  /**
   * @param {(target:{x:number,y:number})=>void} onTarget Fresh face target callback.
   */
  constructor(onTarget) {
    this.onTarget = onTarget;
    this.stream = null;
    this.video = null;
    this.landmarker = null;
    this.frame = 0;
    this.lastVideoTime = -1;
  }

  /** @returns {boolean} Whether the camera is currently running. */
  get running() {
    return Boolean(this.stream);
  }

  /**
   * Start the webcam and per-frame face detection.
   * @returns {Promise<void>} Rejects with a user-readable Error on failure.
   */
  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera not available in this browser.");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
    } catch {
      throw new Error("Camera permission denied.");
    }
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    try {
      if (!this.landmarker) {
        const { FaceLandmarker, FilesetResolver } = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL },
          runningMode: "VIDEO",
          numFaces: 1,
        });
      }
    } catch {
      this.stop();
      throw new Error("Could not load the face tracker. Check your connection and try again.");
    }
    const tick = () => {
      if (!this.stream) return;
      if (this.video && this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        const result = this.landmarker.detectForVideo(this.video, performance.now());
        const landmarks = result?.faceLandmarks?.[0];
        if (landmarks?.length) this.onTarget(faceTarget(landmarks));
      }
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * Stop detection and release the webcam immediately.
   * @returns {void}
   */
  stop() {
    cancelAnimationFrame(this.frame);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
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
