// Builds a client-side model table (Models.txt + Models.json) that includes the
// synthetic ids the editor assigns to dump .adr files with no game modelId
// (roads, city structures, houses, ...). Send/repack the result into the client
// so those placed models actually render in-game — the ids here MATCH what the
// server sends in AddSimpleNpc.
//
// The synthetic id assignment lives in extra-model-ids.json (shared with the
// plugin). This script creates/extends it deterministically, then emits the
// merged tables. Re-runnable: existing ids are preserved.
//
// Usage: node export-client-models.js ["<assetsDir>"]
// Output: plugins/h1emu-web-editor/client-models/{Models.txt,Models.json}

const fs = require("fs");
const path = require("path");

const EXTRA_MODEL_ID_BASE = 500000; // keep in sync with plugin.js

const pluginDir = __dirname;
const serverRoot = path.resolve(pluginDir, "..", "..", "node_modules", "h1z1-server");
const modelsJsonPath = path.join(serverRoot, "data", "2016", "dataSources", "Models.json");

function readConfigAssetsDir() {
  const candidates = [
    path.resolve(pluginDir, "..", "h1emu-web-editor-config.yaml"),
    path.join(pluginDir, "data", "defaultconfig.yaml"),
  ];
  for (const c of candidates) {
    try {
      const m = /^\s*assetsDir:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(fs.readFileSync(c, "utf8"));
      if (m) return m[1].trim();
    } catch (_) {}
  }
  return "E:/big boy stuff/FORMAT/Why2.0";
}

const assetsDir = process.argv[2] || readConfigAssetsDir();
if (!fs.existsSync(assetsDir)) {
  console.error(`Assets dir not found: ${assetsDir}`);
  process.exit(1);
}

// Real models the game already knows (present in the dump), matching the plugin.
const realModels = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
const seen = new Set();
for (const m of realModels) {
  const file = String(m.MODEL_FILE_NAME || "");
  if (!file.toLowerCase().endsWith(".adr")) continue;
  if (!fs.existsSync(path.join(assetsDir, file))) continue;
  seen.add(file.toLowerCase());
}

// Every other .adr in the dump: assign/reuse a stable synthetic id (sorted).
const extraFile = path.join(pluginDir, "extra-model-ids.json");
let idMap = {};
try { idMap = JSON.parse(fs.readFileSync(extraFile, "utf8")) || {}; } catch (_) {}
let nextId = EXTRA_MODEL_ID_BASE;
for (const id of Object.values(idMap)) if (Number(id) >= nextId) nextId = Number(id) + 1;

const dumpAdr = fs.readdirSync(assetsDir)
  .filter((f) => f.toLowerCase().endsWith(".adr") && !seen.has(f.toLowerCase()))
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

let assigned = 0;
const synthetic = []; // { id, file, name }
for (const file of dumpAdr) {
  const key = file.toLowerCase();
  let id = Number(idMap[key]);
  if (!id) { id = nextId++; idMap[key] = id; assigned++; }
  synthetic.push({ id, file, name: file.replace(/\.adr$/i, "") });
}
synthetic.sort((a, b) => a.id - b.id);

// Persist the id map so the running server assigns the exact same ids.
fs.writeFileSync(`${extraFile}.tmp`, JSON.stringify(idMap));
fs.renameSync(`${extraFile}.tmp`, extraFile);

const outDir = path.join(pluginDir, "client-models");
fs.mkdirSync(outDir, { recursive: true });

// ---- merged Models.txt: original client table + appended synthetic rows ----
// Schema: ID^MODEL_FILE_NAME^RACE_ID^SCALE^DESCRIPTION^GENDER^AGE^DESCRIPTOR^
//         MATERIAL_TYPE^WATER_DISPLACEMENT^TELEPORT_EFFECT_ID^CAMERA_DISTANCE^
//         CAMERA_ANGLE^IS_VALID_FOR_PC^
const srcTxtPath = path.join(assetsDir, "Models.txt");
let txt = "";
try { txt = fs.readFileSync(srcTxtPath, "utf8"); } catch (_) {
  txt = "#*ID^MODEL_FILE_NAME^RACE_ID^SCALE^DESCRIPTION^GENDER^AGE^DESCRIPTOR^MATERIAL_TYPE^WATER_DISPLACEMENT^TELEPORT_EFFECT_ID^CAMERA_DISTANCE^CAMERA_ANGLE^IS_VALID_FOR_PC^\n";
}
if (!txt.endsWith("\n")) txt += "\n";
const rows = synthetic.map((s) =>
  `${s.id}^${s.file}^0^1^${s.name}^0^0^^0^0^0^0^0^0^`);
fs.writeFileSync(path.join(outDir, "Models.txt"), txt + rows.join("\n") + "\n");

// ---- merged Models.json: server array + appended synthetic entries ----
const syntheticEntries = synthetic.map((s) => ({
  ID: s.id, MODEL_FILE_NAME: s.file, RACE_ID: 0, SCALE: 1, DESCRIPTION: s.name,
  GENDER: 0, AGE: 0, DESCRIPTOR: "", MATERIAL_TYPE: 0, WATER_DISPLACEMENT: 0,
  TELEPORT_EFFECT_ID: 0, CAMERA_DISTANCE: 0, CAMERA_ANGLE: 0, IS_VALID_FOR_PC: 0,
}));
fs.writeFileSync(path.join(outDir, "Models.json"), JSON.stringify(realModels.concat(syntheticEntries), null, 2));

console.log(`Real models (in dump): ${seen.size}`);
console.log(`Synthetic models: ${synthetic.length} (newly assigned this run: ${assigned})`);
console.log(`Id range: ${EXTRA_MODEL_ID_BASE}..${nextId - 1}`);
console.log(`Wrote ${path.join(outDir, "Models.txt")}`);
console.log(`Wrote ${path.join(outDir, "Models.json")}`);
console.log(`Updated ${extraFile}`);
for (const t of ["Road_City_Straight_32", "Common_Structures_Houses_House21", "Road_City_IntersectionT_64"]) {
  const s = synthetic.find((x) => x.name === t);
  console.log(`  ${t}: ${s ? "id " + s.id : "not found"}`);
}
