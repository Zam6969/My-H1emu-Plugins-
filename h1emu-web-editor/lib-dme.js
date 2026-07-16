// Shared Forgelight .adr/.dme mesh utilities, used by actors-to-models.js at
// bake time and by plugin.js at runtime (on-demand meshes for the builder).
const fs = require("fs");
const path = require("path");

const MAX_VERTS = 120000;

function pickDme(assetsDir, actorName, preferBest = false) {
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
  const ordered = preferBest
    ? [base, ...lods.map((l) => l.fileName)]
    : [...lods.map((l) => l.fileName).reverse(), base];
  for (const c of ordered.filter(Boolean)) {
    const p = path.join(assetsDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function adrTextureAliases(assetsDir, actorName) {
  const p = path.join(assetsDir, actorName.endsWith(".adr") ? actorName : `${actorName}.adr`);
  if (!fs.existsSync(p)) return [];
  const xml = fs.readFileSync(p, "utf8");
  const out = [];
  let m;
  const re = /<Alias\s[^>]*?textureName="([^"]+)"/g;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
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
    if (l.includes("/") || l.includes("\\")) return [n, -10];
    if (/_n\.dds$|_s\.dds$|_e\.dds$|_ns\.dds$|_spec/.test(l)) return [n, -5];
    if (UTILITY_TEX.test(l)) return [n, -3];
    if (/_c\.dds$|_d\.dds$|_ds\.dds$|_cs\.dds$/.test(l)) return [n, 10];
    return [n, 1];
  }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  return scored.length ? scored[0][0] : null;
}

// Parses DME v4: interleaved [x,y,z,u,v] verts + u32 indices + material tex names.
function parseDme(dmePath) {
  const b = fs.readFileSync(dmePath);
  if (b.toString("ascii", 0, 4) !== "DMOD" || b.readUInt32LE(4) !== 4) return null;
  const dmatLen = b.readUInt32LE(8);
  const texNames = [];
  if (b.toString("ascii", 12, 16) === "DMAT") {
    const texLen = b.readUInt32LE(20);
    for (const n of b.toString("utf8", 24, 24 + texLen).split("\0")) if (n) texNames.push(n);
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
    if (vertBase + vertexCount > MAX_VERTS) continue;
    const s0 = streams[0];
    if (s0.bpv < 12) continue;
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

    // UV channel detection: score float2/half2 candidates by plausible range.
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
      if (meanAbs < 0.02 || meanAbs > 6) return;
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
  return { verts, indices, texNames };
}

// Rewrites a DXT1/3/5 .dds keeping only mips <= maxDim (small preview/serving copy).
function capDds(buffer, maxDim = 256) {
  const b = buffer;
  if (b.toString("ascii", 0, 4) !== "DDS ") return null;
  const height = b.readUInt32LE(12), width = b.readUInt32LE(16);
  const mipCount = Math.max(1, b.readUInt32LE(28));
  const fourCC = b.toString("ascii", 84, 88);
  const blockSize = fourCC === "DXT1" ? 8 : (fourCC === "DXT3" || fourCC === "DXT5") ? 16 : 0;
  if (!blockSize) return null;
  let off = 128;
  const levels = [];
  for (let m = 0; m < mipCount; m++) {
    const w = Math.max(1, width >> m), h = Math.max(1, height >> m);
    const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockSize;
    levels.push({ w, h, off, size });
    off += size;
  }
  let kept = levels.filter((l) => Math.max(l.w, l.h) <= maxDim);
  if (!kept.length) kept = [levels[levels.length - 1]];
  const header = Buffer.from(b.subarray(0, 128));
  header.writeUInt32LE(kept[0].h, 12);
  header.writeUInt32LE(kept[0].w, 16);
  header.writeUInt32LE(kept[0].size, 20);
  header.writeUInt32LE(kept.length, 28);
  return Buffer.concat([header, ...kept.map((l) => b.subarray(l.off, l.off + l.size))]);
}

module.exports = { pickDme, parseDme, adrTextureAliases, pickDiffuse, capDds };
