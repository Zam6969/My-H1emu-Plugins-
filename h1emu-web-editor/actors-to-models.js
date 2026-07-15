// Builds the web editor's 3D model library (v2, "ZMD2") with UVs and textures:
//  - one entry per zone actor (same order as zone-objects.bin's name table)
//  - one entry per construction model id found in the world save data
//  - diffuse textures packed (mips capped at 256px) into public/terrain/world-textures/
//
// Usage: node actors-to-models.js "E:/big boy stuff/FORMAT/Why2.0"
//
// Format "ZMD2":
//   magic "ZMD2" | u32 headerLen | header JSON | per entry:
//     u32 vertexCount | u32 indexCount | i32 texIdx |
//     f32 verts[vertexCount*5] (x,y,z,u,v) | u32 indices[indexCount]
//   header JSON: { worldActorCount, constructionModels: {modelId: entryIndex}, textures: [names] }

const fs = require("fs");
const path = require("path");

const assetsDir = process.argv[2];
if (!assetsDir || !fs.existsSync(assetsDir)) {
  console.error("Usage: node actors-to-models.js <assets dir with .adr/.dme/.dds files>");
  process.exit(1);
}

const MAX_VERTS_PER_ENTRY = 60000;
const TEX_MAX_DIM = 256;

// ---------- gather entry list ----------
const zob = fs.readFileSync(path.join(__dirname, "public", "terrain", "zone-objects.bin"));
if (zob.toString("ascii", 0, 4) !== "ZOB1") throw new Error("bad zone-objects.bin");
const zobNames = JSON.parse(zob.toString("utf8", 8, 8 + zob.readUInt32LE(4)));

const modelsJson = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "node_modules", "h1z1-server", "data", "2016", "dataSources", "Models.json"), "utf8"));
const modelFileById = new Map(modelsJson.map((m) => [Number(m.ID), String(m.MODEL_FILE_NAME || "")]));

function collectModelIds(record, out) {
  if (!record || typeof record !== "object") return;
  if (record.actorModelId) out.add(Number(record.actorModelId));
  for (const key of ["occupiedWallSlots", "occupiedUpperWallSlots", "occupiedShelterSlots", "occupiedRampSlots", "occupiedExpansionSlots", "freeplaceEntities"]) {
    for (const child of Object.values(record[key] || {})) collectModelIds(child, out);
  }
}
const constructionIds = new Set();
const worldDataPath = path.join(process.env.APPDATA, "h1emu", "worlddata");
for (const fileName of ["construction.json", "worldconstruction.json"]) {
  try {
    const records = JSON.parse(fs.readFileSync(path.join(worldDataPath, fileName), "utf8"));
    for (const r of records) collectModelIds(r, constructionIds);
  } catch (_) {}
}
console.log(`world actors: ${zobNames.length}, distinct construction model ids: ${constructionIds.size}`);

// ---------- adr/dme parsing ----------
function pickDme(actorName) {
  const adrPath = path.join(assetsDir, actorName.endsWith(".adr") ? actorName : `${actorName}.adr`);
  if (!fs.existsSync(adrPath)) return null;
  const xml = fs.readFileSync(adrPath, "utf8");
  const lods = [];
  let m;
  const lodRe = /<Lod\s[^>]*?\/>/g;
  while ((m = lodRe.exec(xml))) {
    const fileName = /fileName="([^"]+)"/.exec(m[0])?.[1];
    const distance = Number(/distance="([^"]+)"/.exec(m[0])?.[1]) || 0;
    if (fileName) lods.push({ fileName, distance });
  }
  lods.sort((a, b) => a.distance - b.distance);
  const base = /<Base\s[^>]*?fileName="([^"]+)"/.exec(xml)?.[1];
  for (const c of [...lods.map((l) => l.fileName).reverse(), base].filter(Boolean)) {
    const p = path.join(assetsDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return NaN;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

const UTILITY_TEX = /^(detail_|grey|gray|black|white|flat|brown|tan\.|gold|dark_|royal_|slate_|steel_|burnt_)|cube/i;
function pickDiffuse(texNames) {
  const scored = texNames.map((n) => {
    const l = n.toLowerCase();
    if (!l.endsWith(".dds")) return [n, -10];
    if (/_n\.dds$|_s\.dds$|_e\.dds$|_ns\.dds$|_spec/.test(l)) return [n, -5];
    if (UTILITY_TEX.test(l)) return [n, -3];
    if (/_c\.dds$|_d\.dds$|_ds\.dds$|_cs\.dds$/.test(l)) return [n, 10];
    return [n, 1];
  }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  return scored.length ? scored[0][0] : null;
}

function parseDme(dmePath) {
  const b = fs.readFileSync(dmePath);
  if (b.toString("ascii", 0, 4) !== "DMOD" || b.readUInt32LE(4) !== 4) return null;
  const dmatLen = b.readUInt32LE(8);
  // texture names inside DMAT: "DMAT" u32 version u32 texLen then null-separated names
  const texNames = [];
  if (b.toString("ascii", 12, 16) === "DMAT") {
    const texLen = b.readUInt32LE(20);
    const blob = b.toString("utf8", 24, 24 + texLen);
    for (const n of blob.split("\0")) if (n) texNames.push(n);
  }
  let off = 12 + dmatLen;
  const min = [b.readFloatLE(off), b.readFloatLE(off + 4), b.readFloatLE(off + 8)];
  const max = [b.readFloatLE(off + 12), b.readFloatLE(off + 16), b.readFloatLE(off + 20)];
  off += 24;
  const meshCount = b.readUInt32LE(off); off += 4;
  const verts = [];
  const indices = [];
  let vertBase = 0;
  for (let mi = 0; mi < meshCount; mi++) {
    if (off + 32 > b.length) break;
    const streamCount = b.readUInt32LE(off + 16);
    const indexSize = b.readUInt32LE(off + 20) & 0xff;
    const indexCount = b.readUInt32LE(off + 24);
    const vertexCount = b.readUInt32LE(off + 28);
    off += 32;
    if (streamCount < 1 || streamCount > 8 || (indexSize !== 2 && indexSize !== 4) ||
        vertexCount === 0 || vertexCount > 500000 || indexCount > 1500000) return null;
    const streams = [];
    for (let s = 0; s < streamCount; s++) {
      const bpv = b.readUInt32LE(off); off += 4;
      if (bpv > 256 || off + bpv * vertexCount > b.length) return null;
      streams.push({ bpv, dataOff: off });
      off += bpv * vertexCount;
    }
    const indexOff = off;
    off += indexCount * indexSize;
    if (off > b.length) return null;
    if (vertBase + vertexCount > MAX_VERTS_PER_ENTRY) continue;
    const s0 = streams[0];
    if (s0.bpv < 12) continue;
    // validate positions against AABB
    const pad = Math.max(1, (max[0] - min[0]) * 0.1);
    let inside = 0, sampled = 0;
    const step = Math.max(1, Math.floor(vertexCount / 100));
    for (let v = 0; v < vertexCount; v += step) {
      const o = s0.dataOff + v * s0.bpv;
      const x = b.readFloatLE(o), y = b.readFloatLE(o + 4), z = b.readFloatLE(o + 8);
      sampled++;
      if (x >= min[0] - pad && x <= max[0] + pad && y >= min[1] - pad && y <= max[1] + pad && z >= min[2] - pad && z <= max[2] + pad) inside++;
    }
    if (inside / sampled < 0.95) continue;

    // find UVs: try (stream, byteOffset, type) candidates, score by plausible range
    let best = null;
    const tryCandidate = (si, byteOff, type) => {
      const st = streams[si];
      let ok = 0, n = 0, sumAbs = 0;
      for (let v = 0; v < vertexCount; v += step) {
        const o = st.dataOff + v * st.bpv + byteOff;
        let u, w;
        if (type === "f2") { u = b.readFloatLE(o); w = b.readFloatLE(o + 4); }
        else { u = halfToFloat(b.readUInt16LE(o)); w = halfToFloat(b.readUInt16LE(o + 2)); }
        n++;
        if (Number.isFinite(u) && Number.isFinite(w) && Math.abs(u) <= 16 && Math.abs(w) <= 16) {
          ok++;
          sumAbs += Math.min(Math.abs(u), 4) + Math.min(Math.abs(w), 4);
        }
      }
      if (!n || ok / n < 0.99) return;
      const meanAbs = sumAbs / (2 * ok);
      if (meanAbs < 0.02 || meanAbs > 6) return; // all-zero or wild data is not UV
      const score = (type === "h2" ? 1.05 : 1.0) * (1 / (1 + Math.abs(meanAbs - 0.55)));
      if (!best || score > best.score) best = { si, byteOff, type, score };
    };
    for (let si = 0; si < streams.length; si++) {
      const startOff = si === 0 ? 12 : 0;
      for (let bo = startOff; bo + 4 <= streams[si].bpv; bo += 4) {
        if (bo + 8 <= streams[si].bpv) tryCandidate(si, bo, "f2");
        tryCandidate(si, bo, "h2");
      }
    }

    for (let v = 0; v < vertexCount; v++) {
      const o = s0.dataOff + v * s0.bpv;
      let u = 0, w = 0;
      if (best) {
        const st = streams[best.si];
        const uo = st.dataOff + v * st.bpv + best.byteOff;
        if (best.type === "f2") { u = b.readFloatLE(uo); w = b.readFloatLE(uo + 4); }
        else { u = halfToFloat(b.readUInt16LE(uo)); w = halfToFloat(b.readUInt16LE(uo + 2)); }
        if (!Number.isFinite(u)) u = 0;
        if (!Number.isFinite(w)) w = 0;
      }
      verts.push(b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8), u, w);
    }
    for (let i = 0; i < indexCount; i++) {
      indices.push(vertBase + (indexSize === 2 ? b.readUInt16LE(indexOff + i * 2) : b.readUInt32LE(indexOff + i * 4)));
    }
    vertBase += vertexCount;
  }
  if (!verts.length || !indices.length) return null;
  return { verts, indices, texture: pickDiffuse(texNames) };
}

// ---------- texture packing (cap mips at TEX_MAX_DIM) ----------
const texIndexByName = new Map();
const textures = [];
const texOutDir = path.join(__dirname, "public", "terrain", "world-textures");
fs.mkdirSync(texOutDir, { recursive: true });

function packTexture(name) {
  if (texIndexByName.has(name)) return texIndexByName.get(name);
  const src = path.join(assetsDir, name);
  if (!fs.existsSync(src)) { texIndexByName.set(name, -1); return -1; }
  try {
    const b = fs.readFileSync(src);
    if (b.toString("ascii", 0, 4) !== "DDS ") throw new Error("not dds");
    const height = b.readUInt32LE(12), width = b.readUInt32LE(16);
    const mipCount = Math.max(1, b.readUInt32LE(28));
    const fourCC = b.toString("ascii", 84, 88);
    let blockSize;
    if (fourCC === "DXT1") blockSize = 8;
    else if (fourCC === "DXT3" || fourCC === "DXT5") blockSize = 16;
    else throw new Error(`unsupported format ${fourCC}`);
    // walk mips, keep those with max dim <= TEX_MAX_DIM (or the last few)
    let off = 128;
    const levels = [];
    for (let m = 0; m < mipCount; m++) {
      const w = Math.max(1, width >> m), h = Math.max(1, height >> m);
      const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockSize;
      levels.push({ w, h, off, size });
      off += size;
    }
    let kept = levels.filter((l) => Math.max(l.w, l.h) <= TEX_MAX_DIM);
    if (!kept.length) kept = [levels[levels.length - 1]];
    const header = Buffer.from(b.subarray(0, 128));
    header.writeUInt32LE(kept[0].h, 12);
    header.writeUInt32LE(kept[0].w, 16);
    header.writeUInt32LE(kept[0].size, 20);
    header.writeUInt32LE(kept.length, 28);
    const out = Buffer.concat([header, ...kept.map((l) => b.subarray(l.off, l.off + l.size))]);
    fs.writeFileSync(path.join(texOutDir, name), out);
    const idx = textures.length;
    textures.push(name);
    texIndexByName.set(name, idx);
    return idx;
  } catch (err) {
    texIndexByName.set(name, -1);
    return -1;
  }
}

// ---------- build entries ----------
const entries = [];
function buildEntry(adrName) {
  const dmePath = adrName ? pickDme(adrName) : null;
  if (!dmePath) return { verts: [], indices: [], texIdx: -1 };
  let mesh = null;
  try { mesh = parseDme(dmePath); } catch (_) { mesh = null; }
  if (!mesh) return { verts: [], indices: [], texIdx: -1 };
  return { verts: mesh.verts, indices: mesh.indices, texIdx: mesh.texture ? packTexture(mesh.texture) : -1 };
}

let okWorld = 0;
for (const meta of zobNames) {
  const e = buildEntry(meta.n);
  if (e.verts.length) okWorld++;
  entries.push(e);
}
const constructionModels = {};
let okCon = 0, missCon = [];
for (const id of [...constructionIds].sort((a, b) => a - b)) {
  const adr = modelFileById.get(id);
  const e = buildEntry(adr || null);
  if (e.verts.length) okCon++;
  else missCon.push(`${id}:${adr || "?"}`);
  constructionModels[id] = entries.length;
  entries.push(e);
}
console.log(`world entries ok: ${okWorld}/${zobNames.length}`);
console.log(`construction entries ok: ${okCon}/${constructionIds.size}${missCon.length ? ` missing: ${missCon.join(", ")}` : ""}`);
console.log(`textures packed: ${textures.length}`);

// ---------- write ----------
let headerJson = JSON.stringify({
  worldActorCount: zobNames.length,
  constructionModels,
  textures,
});
while (Buffer.byteLength(headerJson) % 4 !== 0) headerJson += " "; // keep entries 4-byte aligned
const header = Buffer.from(headerJson, "utf8");
let size = 8 + header.length;
for (const e of entries) size += 12 + e.verts.length * 4 + e.indices.length * 4;
const out = Buffer.alloc(size);
let off = 0;
out.write("ZMD2", off); off += 4;
out.writeUInt32LE(header.length, off); off += 4;
header.copy(out, off); off += header.length;
for (const e of entries) {
  out.writeUInt32LE(e.verts.length / 5, off);
  out.writeUInt32LE(e.indices.length, off + 4);
  out.writeInt32LE(e.texIdx, off + 8);
  off += 12;
  for (const v of e.verts) { out.writeFloatLE(v, off); off += 4; }
  for (const i of e.indices) { out.writeUInt32LE(i, off); off += 4; }
}
const outPath = path.join(__dirname, "public", "terrain", "world-models.bin");
fs.writeFileSync(outPath, out);
const texBytes = fs.readdirSync(texOutDir).reduce((s, f) => s + fs.statSync(path.join(texOutDir, f)).size, 0);
console.log(`Wrote ${outPath} (${(out.length / 1024 / 1024).toFixed(1)} MB) + ${(texBytes / 1024 / 1024).toFixed(1)} MB textures`);
