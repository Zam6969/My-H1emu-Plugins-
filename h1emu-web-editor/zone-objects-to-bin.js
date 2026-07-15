// Bakes the .zone file's runtime objects (roads, buildings, props) into a compact
// binary the web editor renders as placeholder boxes.
//
// Usage: node zone-objects-to-bin.js "E:/big boy stuff/FORMAT/Why2.0/Z1.zone"
// Output: public/terrain/zone-objects.bin
//
// Format "ZOB1":
//   magic "ZOB1" | u32 nameTableBytes | nameTable JSON (utf8) | u32 instanceCount
//   per instance (24 bytes): f32 x, y, z | f32 yaw | f32 scale | u32 nameIndex
// Name table entries: { n: actor name, c: category, e: [w, h, d] box size, rd: renderDistance }

const fs = require("fs");
const path = require("path");
const { readZone } = require("C:/Users/zam/Documents/H1emu/H1EmuServerFiles/h1z1-server-QuickStart-master/node_modules/h1emu-zone2json/out/zone.js");

const zonePath = process.argv[2];
if (!zonePath || !fs.existsSync(zonePath)) {
  console.error("Usage: node zone-objects-to-bin.js <path to Z1.zone>");
  process.exit(1);
}

function categorize(name) {
  const n = name.toLowerCase();
  if (n.includes("road_") || n.startsWith("road")) return "road";
  if (n.includes("sidewalk") || n.includes("parkinglot") || n.includes("driveway")) return "sidewalk";
  if (n.includes("bridge")) return "bridge";
  if (n.includes("wrecked") || n.includes("vehicle")) return "wreck";
  if (n.includes("fence") || n.includes("barbedwire") || n.includes("guardrail") || n.includes("wall")) return "fence";
  if (n.includes("boulder") || n.includes("rock") || n.includes("cliff")) return "rock";
  if (n.includes("sign")) return "sign";
  if (n.includes("structures") || n.includes("building") || n.includes("house") || n.includes("cabin") ||
      n.includes("church") || n.includes("store") || n.includes("barn") || n.includes("warehouse") ||
      n.includes("tower") || n.includes("silo") || n.includes("shed") || n.includes("trailer") ||
      n.includes("motel") || n.includes("gasstation") || n.includes("hangar") || n.includes("mall") ||
      n.includes("school") || n.includes("hospital") || n.includes("office") || n.includes("apartment")) return "structure";
  return "prop";
}

function boxSize(name, category) {
  const n = name.toLowerCase();
  const len = (() => {
    const m = n.match(/_(\d{1,3})(?:m|x|\.|_|$)/);
    return m ? Math.min(128, Math.max(2, Number(m[1]))) : 0;
  })();
  switch (category) {
    case "road": return [len || 24, 0.25, 14];
    case "sidewalk": return [len || 8, 0.2, 3];
    case "bridge": return [len || 30, 1.2, 12];
    case "wreck": return [4.6, 1.7, 2.1];
    case "fence": return [len || 3.5, 1.6, 0.3];
    case "rock": return [3.2, 2.2, 3.2];
    case "sign": return [1.2, 2.4, 0.25];
    case "structure": {
      if (n.includes("tower")) return [5, 14, 5];
      if (n.includes("silo")) return [6, 12, 6];
      if (n.includes("shed") || n.includes("outhouse")) return [4, 3, 4];
      const s = len ? Math.min(40, len) : 12;
      return [s, 7, s];
    }
    default: return [1.8, 1.6, 1.8];
  }
}

const buf = fs.readFileSync(zonePath);
const zone = readZone(buf, 0);
const objects = zone.objects || [];
console.log(`Zone parsed: ${objects.length} runtime objects`);

const names = [];
const records = [];
for (const obj of objects) {
  const actor = String(obj.actorDefinition || "unknown.adr").replace(/\.adr$/i, "");
  const category = categorize(actor);
  const nameIndex = names.length;
  names.push({ n: actor, c: category, e: boxSize(actor, category), rd: Number(obj.renderDistance) || 200 });
  for (const inst of obj.instances || []) {
    const p = inst.position || [0, 0, 0];
    const rot = inst.rotation || [0, 0, 0];
    const scl = inst.scale || [1, 1, 1];
    records.push([p[0], p[1], p[2], Number(rot[0]) || 0, Number(scl[0]) || 1, nameIndex]);
  }
}
console.log(`Instances: ${records.length}, actors: ${names.length}`);

const nameTable = Buffer.from(JSON.stringify(names), "utf8");
const out = Buffer.alloc(4 + 4 + nameTable.length + 4 + records.length * 24);
let off = 0;
out.write("ZOB1", off); off += 4;
out.writeUInt32LE(nameTable.length, off); off += 4;
nameTable.copy(out, off); off += nameTable.length;
out.writeUInt32LE(records.length, off); off += 4;
for (const r of records) {
  out.writeFloatLE(r[0], off); out.writeFloatLE(r[1], off + 4); out.writeFloatLE(r[2], off + 8);
  out.writeFloatLE(r[3], off + 12); out.writeFloatLE(r[4], off + 16); out.writeUInt32LE(r[5], off + 20);
  off += 24;
}

const outPath = path.join(__dirname, "public", "terrain", "zone-objects.bin");
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${(out.length / 1024 / 1024).toFixed(1)} MB)`);
