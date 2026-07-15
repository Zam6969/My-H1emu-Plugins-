// Convert a mongoexport dump of the CONSTRUCTION collection (concatenated
// pretty-printed extended-JSON documents) into the plain JSON array the
// solo-mode h1z1-server loads from worlddata/construction.json.
const fs = require("fs");
const path = require("path");

const file = path.join(process.env.APPDATA, "h1emu", "worlddata", "construction.json");
const raw = fs.readFileSync(file, "utf8");
console.log(`input: ${(raw.length / 1024 / 1024).toFixed(1)} MB`);

// Split concatenated JSON documents by tracking depth outside strings.
const docs = [];
let depth = 0, inStr = false, esc = false, start = -1;
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i];
  if (inStr) {
    if (esc) esc = false;
    else if (ch === "\\") esc = true;
    else if (ch === '"') inStr = false;
    continue;
  }
  if (ch === '"') inStr = true;
  else if (ch === "{" || ch === "[") {
    if (depth === 0) start = i;
    depth++;
  } else if (ch === "}" || ch === "]") {
    depth--;
    if (depth === 0 && start >= 0) {
      docs.push(raw.slice(start, i + 1));
      start = -1;
    }
  }
}
console.log(`found ${docs.length} JSON documents`);

const NUM_KEYS = new Set(["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]);
function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const k = keys[0];
      if (NUM_KEYS.has(k)) return Number(value[k]);
      if (k === "$oid") return String(value[k]);
      if (k === "$date") return unwrap(value[k]);
    }
    const out = {};
    for (const k of keys) {
      if (k === "_id") continue;
      out[k] = unwrap(value[k]);
    }
    return out;
  }
  return value;
}

const records = [];
let bad = 0;
for (const doc of docs) {
  let parsed;
  try {
    parsed = unwrap(JSON.parse(doc));
  } catch (e) {
    bad++;
    continue;
  }
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (r?.characterId && r?.position) { r.serverId = 0; records.push(r); }
    }
    continue;
  }
  if (!parsed?.characterId || !parsed?.position) { bad++; continue; }
  parsed.serverId = 0;
  records.push(parsed);
}
console.log(`converted: ${records.length} construction records, skipped: ${bad}`);

// sanity checks
let entityCount = 0;
const walk = (r) => {
  if (!r || typeof r !== "object") return;
  if (r.characterId) entityCount++;
  for (const key of ["occupiedWallSlots", "occupiedUpperWallSlots", "occupiedShelterSlots", "occupiedRampSlots", "occupiedExpansionSlots", "freeplaceEntities"]) {
    for (const c of Object.values(r[key] || {})) walk(c);
  }
};
for (const r of records) walk(r);
const posOk = records.every(r => Array.isArray(r.position) && r.position.length >= 3 && r.position.every(n => typeof n === "number" && Number.isFinite(n)));
console.log(`total entities incl. children: ${entityCount}, all positions numeric: ${posOk}`);
console.log("sample record keys:", Object.keys(records[0] || {}).join(", "));
console.log("sample pos/euler:", JSON.stringify(records[0]?.position), records[0]?.eulerAngle);

if (!records.length || !posOk) {
  console.error("ABORT: conversion did not produce valid records; nothing written.");
  process.exit(1);
}

fs.renameSync(file, file + ".mongoexport.bak");
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(records));
fs.renameSync(tmp, file);
console.log(`wrote ${file} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB); original kept as construction.json.mongoexport.bak`);
