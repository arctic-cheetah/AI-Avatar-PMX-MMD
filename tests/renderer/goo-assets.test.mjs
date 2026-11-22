// Baked Goo shader inputs (#250): the renderer only uses them when they line up
// with the PMX it loaded. A mismatch must be reported, never drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";
import { decodeCol, validateGooAssets } from "../../renderer/goo-assets.js";

const PMX = { vertexCount: 3, materialNames: ["颜", "目影", "髮+"] };

function assets() {
  return {
    manifest: { version: 1, pmx: { vertexCount: 3, materials: ["颜", "目影", "髮+"] } },
    materialMap: {
      materials: [
        { pmx: "颜", game: "Yidhari Face", hidden: false, shader: "zzzb", textures: { diffuse: "Yidhari_Face_D.png" } },
        // Eye Shadow is a tinted Transparent BSDF: it darkens what is behind it.
        { pmx: "目影", game: "Eye Shadow", hidden: false, shader: "transparent", color: [0.46, 0.58, 0.68, 1], textures: {} },
        { pmx: "髮+", game: null, hidden: true, shader: null, textures: {} },
      ],
    },
    colBytes: new Uint8Array(12),
  };
}

test("matching assets pass", () => {
  assert.deepEqual(validateGooAssets(assets(), PMX), { ok: true, errors: [] });
});

test("a different vertex count is reported", () => {
  const baked = assets();
  baked.manifest.pmx.vertexCount = 4;
  const result = validateGooAssets(baked, PMX);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /baked for 4 vertices, the PMX has 3/);
});

test("materials in a different order are reported", () => {
  const baked = assets();
  baked.manifest.pmx.materials = ["髮+", "目影", "颜"];
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /material 0 is 髮\+ in the bake, 颜 in the PMX/);
});

test("a colour buffer of the wrong length is reported", () => {
  const baked = assets();
  baked.colBytes = new Uint8Array(8);
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /col\.bin has 8 bytes, expected 12/);
});

test("a Goo shader material without a diffuse texture is reported", () => {
  const baked = assets();
  baked.materialMap.materials[0].textures = {};
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /颜 has no diffuse texture/);
});

test("a transparent tint material without a colour is reported", () => {
  const baked = assets();
  delete baked.materialMap.materials[1].color;
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /目影 is a transparent tint without a colour/);
});

test("a visible material with an unknown shader is reported", () => {
  const baked = assets();
  baked.materialMap.materials[1].shader = "principled";
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /目影 uses unsupported shader principled/);
});

test("a material map out of step with the manifest is reported", () => {
  const baked = assets();
  baked.materialMap.materials[2].pmx = "髮";
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /material map entry 2 is 髮, expected 髮\+/);
});

test("an unknown manifest version is reported", () => {
  const baked = assets();
  baked.manifest.version = 2;
  assert.match(validateGooAssets(baked, PMX).errors.join("\n"), /manifest version 2 is not supported/);
});

test("decodeCol returns RGBA8 per vertex and refuses a wrong length", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...decodeCol(bytes.buffer, 2)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => decodeCol(bytes.buffer, 3), /col\.bin has 8 bytes, expected 12/);
});

// Real-model check: skipped unless the private PMX and a bake are present.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PMX_PATH = process.env.YIDHARI_PMX ?? `${ROOT}yidhari-mmd/伊德海莉.pmx`;
const GOO_DIR = process.env.GOO_ASSETS_DIR ?? `${ROOT}assets/private/goo`;
const haveReal = existsSync(PMX_PATH) && existsSync(`${GOO_DIR}/manifest.json`);

test("the private bake lines up with the private PMX", { skip: !haveReal && "private PMX or bake not present" }, () => {
  const buf = readFileSync(PMX_PATH);
  const pmx = new MMDParser.Parser().parsePmx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), true);
  const read = (name) => JSON.parse(readFileSync(`${GOO_DIR}/${name}`, "utf8"));
  const baked = {
    manifest: read("manifest.json"),
    materialMap: read("material-map.json"),
    colBytes: new Uint8Array(readFileSync(`${GOO_DIR}/col.bin`)),
  };
  const result = validateGooAssets(baked, {
    vertexCount: pmx.metadata.vertexCount,
    materialNames: pmx.materials.map((m) => m.name),
  });
  assert.deepEqual(result, { ok: true, errors: [] });
  for (const entry of baked.materialMap.materials) {
    for (const file of Object.values(entry.textures)) assert.ok(existsSync(`${GOO_DIR}/textures/${file}`), file);
  }
});
