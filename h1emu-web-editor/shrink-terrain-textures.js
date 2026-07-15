// Writes mip-capped copies of the terrain chunk textures to textures-small/.
// The plugin serves these when present — same visual quality at editor view
// distances, ~4x smaller download and GPU memory.
//
// Usage: node shrink-terrain-textures.js [maxDimension=512]

const fs = require("fs");
const path = require("path");

const MAX_DIM = Number(process.argv[2]) || 512;
const srcDir = path.join(__dirname, "public", "terrain", "textures");
const outDir = path.join(__dirname, "public", "terrain", "textures-small");
fs.mkdirSync(outDir, { recursive: true });

let done = 0, skipped = 0, inBytes = 0, outBytes = 0;
for (const name of fs.readdirSync(srcDir)) {
  if (!name.toLowerCase().endsWith(".dds")) continue;
  const b = fs.readFileSync(path.join(srcDir, name));
  inBytes += b.length;
  try {
    if (b.toString("ascii", 0, 4) !== "DDS ") throw new Error("not dds");
    const height = b.readUInt32LE(12), width = b.readUInt32LE(16);
    const mipCount = Math.max(1, b.readUInt32LE(28));
    const fourCC = b.toString("ascii", 84, 88);
    const blockSize = fourCC === "DXT1" ? 8 : (fourCC === "DXT3" || fourCC === "DXT5") ? 16 : 0;
    if (!blockSize) throw new Error(`format ${fourCC}`);
    let off = 128;
    const levels = [];
    for (let m = 0; m < mipCount; m++) {
      const w = Math.max(1, width >> m), h = Math.max(1, height >> m);
      const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockSize;
      levels.push({ w, h, off, size });
      off += size;
    }
    let kept = levels.filter((l) => Math.max(l.w, l.h) <= MAX_DIM);
    if (!kept.length) kept = [levels[levels.length - 1]];
    const header = Buffer.from(b.subarray(0, 128));
    header.writeUInt32LE(kept[0].h, 12);
    header.writeUInt32LE(kept[0].w, 16);
    header.writeUInt32LE(kept[0].size, 20);
    header.writeUInt32LE(kept.length, 28);
    const out = Buffer.concat([header, ...kept.map((l) => b.subarray(l.off, l.off + l.size))]);
    fs.writeFileSync(path.join(outDir, name), out);
    outBytes += out.length;
    done++;
  } catch (_) {
    skipped++;
  }
}
console.log(`capped ${done} textures at ${MAX_DIM}px (skipped ${skipped})`);
console.log(`${(inBytes / 1024 / 1024).toFixed(0)} MB -> ${(outBytes / 1024 / 1024).toFixed(0)} MB in ${outDir}`);
