import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MMDLoader } from "three/addons/loaders/MMDLoader.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";

const MODEL_URL = "/yidhari-mmd/伊德海莉.pmx";
const BLINK_MORPH = "まばたき";

const statusEl = document.querySelector("#status");
const canvas = document.querySelector("#view");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141018);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
camera.position.set(0, 12, 18);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const outline = new OutlineEffect(renderer);

scene.add(new THREE.AmbientLight(0xffffff, 2.2));
const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
key.position.set(4, 10, 8);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9eb6ff, 0.7);
fill.position.set(-6, 4, -2);
scene.add(fill);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshStandardMaterial({
    color: 0x221c28,
    roughness: 0.95,
    metalness: 0,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 11, 0);
controls.enableDamping = true;
controls.minDistance = 3;
controls.maxDistance = 80;

let mesh = null;
let blinkIndex = -1;
let blinkWeight = 0;
let nextBlinkAt = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  outline.setSize(width, height);
}

function boneWorld(object, name) {
  const bone = object.skeleton?.getBoneByName(name);
  if (!bone) {
    return null;
  }
  bone.updateWorldMatrix(true, false);
  return bone.getWorldPosition(new THREE.Vector3());
}

function frameModel(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.position.y -= box.min.y;
  object.updateMatrixWorld(true);

  const head = boneWorld(object, "頭");
  const lookAt = head
    ? new THREE.Vector3(head.x, head.y - 1.7, head.z)
    : new THREE.Vector3(0, 13.5, 0);
  controls.target.copy(lookAt);
  camera.position.set(lookAt.x, lookAt.y + 0.05, lookAt.z + 12.2);
  camera.near = 0.05;
  camera.far = 400;
  camera.updateProjectionMatrix();
  controls.minDistance = 3;
  controls.maxDistance = 80;
  controls.update();
  floor.scale.setScalar(Math.max(18, (head ? head.y : 22) * 0.9));
}

function scheduleBlink(now) {
  nextBlinkAt = now + 2.4 + Math.random() * 3.2;
}

function updateBlink(now) {
  if (blinkIndex < 0) {
    return;
  }
  if (now >= nextBlinkAt && blinkWeight === 0) {
    blinkWeight = 0.001;
  }
  if (blinkWeight > 0) {
    const closing = blinkWeight < 1 && now < nextBlinkAt + 0.09;
    blinkWeight = closing
      ? Math.min(1, blinkWeight + 0.18)
      : Math.max(0, blinkWeight - 0.12);
    mesh.morphTargetInfluences[blinkIndex] = blinkWeight;
    if (blinkWeight === 0) {
      scheduleBlink(now);
    }
  }
}

function loadModel() {
  setStatus("Loading PMX…");
  const loader = new MMDLoader();
  loader.load(
    MODEL_URL,
    (loaded) => {
      mesh = loaded;
      scene.add(mesh);
      frameModel(mesh);

      const names = mesh.geometry?.morphAttributes?.position ?? [];
      blinkIndex = names.findIndex((attribute) => attribute.name === BLINK_MORPH);
      if (blinkIndex < 0 && mesh.morphTargetDictionary) {
        blinkIndex = mesh.morphTargetDictionary[BLINK_MORPH] ?? -1;
      }

      const morphCount = mesh.morphTargetInfluences?.length ?? 0;
      setStatus(`Ready · ${morphCount} morphs`);
      scheduleBlink(performance.now() / 1000);
    },
    (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        setStatus(`Loading PMX… ${pct}%`);
      }
    },
    (error) => {
      console.error(error);
      setStatus("Could not load the PMX. Is serve.py running?");
    },
  );
}

const clock = new THREE.Clock();

function animate() {
  const now = clock.elapsedTime;
  controls.update();
  updateBlink(now);
  outline.render(scene, camera);
}

resize();
window.addEventListener("resize", resize);
renderer.setAnimationLoop(animate);
loadModel();
