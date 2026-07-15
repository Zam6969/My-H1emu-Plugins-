#!/usr/bin/env python3
# Forgelight CNK terrain chunk to binary mesh converter for H1Emu web editor.
# Reads .cnk1 (LOD terrain) files, decompresses LZHAM, outputs combined binary mesh
# in the TRRN v2 format the editor client (app.html) parses:
#   "TRRN" | vcount u32 | icount u32 | chunkCount u32
#   positions f32*3*vcount | colors f32*3*vcount | uvs f32*2*vcount | indices u32*icount
#   per chunk: firstVert u32 | indexStart u32 | indexCount u32 | z i32 | x i32
#
# Usage:
#   python cnk-to-obj.py <assets_dir> [--output <output_dir>]
#
# Example:
#   python cnk-to-obj.py "E:/big boy stuff/FORMAT/Why2.0"

import argparse
import ctypes
import glob
import json
import os
import struct
import sys
from array import array
from pathlib import Path

LZHAM_Z_OK = 0
LZHAM_Z_STREAM_END = 1

DLL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lzham-forgelightx64.dll")

def load_lzham_dll():
    p = os.path.normpath(DLL_PATH)
    if os.path.exists(p):
        dll = ctypes.CDLL(p)
        dll.decompress_forgelight_data.argtypes = [
            ctypes.c_char_p, ctypes.c_uint32,
            ctypes.c_char_p, ctypes.c_uint32,
        ]
        dll.decompress_forgelight_data.restype = ctypes.c_int
        print(f"Loaded LZHAM DLL: {p}")
        return dll
    print(f"ERROR: LZHAM DLL not found at {p}")
    sys.exit(1)

def decompress_lzham(dll, compressed_data, decompressed_size):
    src = ctypes.create_string_buffer(compressed_data)
    dst = ctypes.create_string_buffer(decompressed_size)
    result = dll.decompress_forgelight_data(src, len(compressed_data), dst, decompressed_size)
    if result not in (LZHAM_Z_OK, LZHAM_Z_STREAM_END):
        raise RuntimeError(f"LZHAM decompression failed: {result}")
    return dst.raw[:decompressed_size]

def parse_zone_header(zone_path):
    with open(zone_path, "rb") as f:
        magic = f.read(4)
        if magic != b"ZONE":
            raise ValueError(f"Not a zone file")
        version = struct.unpack("<I", f.read(4))[0]
        if version in (3, 4):
            f.read(4)
        for _ in range(6):
            struct.unpack("<I", f.read(4))
        if version in (3, 4):
            struct.unpack("<I", f.read(4))
        return {
            "quadsPerTile": struct.unpack("<I", f.read(4))[0],
            "tileSize": struct.unpack("<f", f.read(4))[0],
            "tileHeight": struct.unpack("<f", f.read(4))[0],
            "vertsPerTile": struct.unpack("<I", f.read(4))[0],
            "tilesPerChunk": struct.unpack("<I", f.read(4))[0],
            "startX": struct.unpack("<i", f.read(4))[0],
            "startY": struct.unpack("<i", f.read(4))[0],
            "chunksX": struct.unpack("<I", f.read(4))[0],
            "chunksY": struct.unpack("<I", f.read(4))[0],
        }

def parse_cnk1(dll, cnk_path):
    with open(cnk_path, "rb") as f:
        magic = f.read(4)
        if magic[:3] != b"CNK":
            raise ValueError(f"Not a CNK file")
        version = struct.unpack("<I", f.read(4))[0]
        decomp_size = struct.unpack("<I", f.read(4))[0]
        comp_size = struct.unpack("<I", f.read(4))[0]
        comp_data = f.read(comp_size)

    d = decompress_lzham(dll, comp_data, decomp_size)

    def ru32(off):
        return struct.unpack_from("<I", d, off)[0]

    off = 0

    # Textures (4 entries of 6 length-prefixed blobs)
    tex_count = ru32(off); off += 4
    for _ in range(tex_count):
        for _ in range(6):
            sz = ru32(off); off += 4 + sz

    # VertsPerSide (65 for H1Z1 CNK1)
    verts_per_side = ru32(off); off += 4

    # HeightMaps: 4 quadrants x verts_per_side^2 entries of
    # (i16 height == vertex hfar, u8, u8), x-major within each quadrant.
    hm_count = ru32(off); off += 4
    heightmap = struct.unpack_from(f"<{hm_count * 2}h", d, off)[::2]
    off += hm_count * 4

    # Indices (relative to each render batch's vertex range)
    idx_count = ru32(off); off += 4
    indices = struct.unpack_from(f"<{idx_count}H", d, off)
    off += idx_count * 2

    # Vertices: i16 x, i16 y, i16 heightFar, i16 heightNear, u32 color
    vert_count = ru32(off); off += 4
    vertices = list(struct.iter_unpack("<hhhhI", d[off:off + vert_count * 12]))
    off += vert_count * 12

    # Render batches (one per 65x65 quadrant)
    batch_count = ru32(off); off += 4
    batches = []
    for _ in range(batch_count):
        if version == 2:
            off += 4  # skip unknown
        ioff = ru32(off); off += 4
        icnt = ru32(off); off += 4
        voff = ru32(off); off += 4
        vcnt = ru32(off); off += 4
        batches.append((ioff, icnt, voff, vcnt))

    return {
        "vertices": vertices,
        "indices": indices,
        "batches": batches,
        "vertsPerSide": verts_per_side,
        "heightmap": heightmap,
    }

def chunk_coords_from_filename(filename):
    base = Path(filename).stem
    parts = base.split("_")
    if len(parts) >= 3:
        try:
            return int(parts[1]), int(parts[2])
        except ValueError:
            pass
    return None, None

def build_terrain_mesh(chunk_data_list, chunk_coords_list):
    """
    Chunk placement (verified against neighboring-chunk heightmap seams and
    saved-construction ground heights from the live server world):
      worldX = (nameElements[2] * 32 + localX) * 2
      worldZ = (nameElements[1] * 32 + localY) * 2
    Do NOT negate the chunk X position (TerrainFactory.cs does, but it also
    flips the mesh axis elsewhere; negating placement alone mirrors every
    chunk column against its own content and opens height cliffs at X seams).

    Each CNK1 has 4 render batches, one per 65x65-vertex quadrant. Quadrant
    grid offsets: x += (batchIndex >> 1) * 64, y += (batchIndex % 2) * 64.
    Every batch covers its full 0..64 vertex range; dropping any row leaves
    visible cracks between chunks, so all vertices are kept verbatim.

    UV convention (matches Z1_{z}_{x}_colornx.dds orientation — the texture is
    stitched 2x2 from the cnk1's four embedded quadrant textures in entry
    order 0=TL 1=TR 2=BL 3=BR, i.e. image row = localX quadrant, col = localY):
      u = localY / 128, v = localX / 128
    """
    positions = array("f")
    colors = array("f")
    uvs = array("f")
    all_indices = array("I")
    chunk_records = []
    vertex_offset = 0
    warned = 0

    for chunk_data, (chunk_z, chunk_x) in zip(chunk_data_list, chunk_coords_list):
        chunk_pos_x = chunk_x * 32
        chunk_pos_z = chunk_z * 32

        verts = chunk_data["vertices"]
        indices = chunk_data["indices"]
        side = chunk_data["vertsPerSide"]
        heightmap = chunk_data["heightmap"]
        first_vert = vertex_offset
        index_start = len(all_indices)

        for batch_idx, (ioff, icnt, voff, vcnt) in enumerate(chunk_data["batches"][:4]):
            q_off_x = (batch_idx >> 1) * 64
            q_off_y = (batch_idx % 2) * 64
            hm_base = batch_idx * side * side

            bxs = [v[0] for v in verts[voff:voff + vcnt]]
            bys = [v[1] for v in verts[voff:voff + vcnt]]
            if bxs and (min(bxs) != 0 or max(bxs) != 64 or min(bys) != 0 or max(bys) != 64) and warned < 10:
                print(f"  WARNING: Z1_{chunk_z}_{chunk_x} batch {batch_idx} covers "
                      f"X:[{min(bxs)},{max(bxs)}] Y:[{min(bys)},{max(bys)}], expected [0,64]")
                warned += 1

            for i in range(voff, min(voff + vcnt, len(verts))):
                vx, vy, hfar, hnear, color = verts[i]
                local_x = vx + q_off_x
                local_y = vy + q_off_y
                positions.append((chunk_pos_x + local_x) * 2.0)
                positions.append(hnear / 32.0)
                positions.append((chunk_pos_z + local_y) * 2.0)
                colors.append(((color >> 16) & 0xFF) / 255.0)
                colors.append(((color >> 8) & 0xFF) / 255.0)
                colors.append((color & 0xFF) / 255.0)
                uvs.append(local_y / 128.0)
                uvs.append(local_x / 128.0)
                if hfar != heightmap[hm_base + vx * side + vy] and warned < 10:
                    print(f"  WARNING: Z1_{chunk_z}_{chunk_x} heightmap mismatch at "
                          f"batch {batch_idx} vert ({vx},{vy})")
                    warned += 1

            batch_indices = indices[ioff:ioff + icnt]
            if batch_indices and max(batch_indices) >= vcnt:
                raise ValueError(f"Z1_{chunk_z}_{chunk_x} batch {batch_idx} index out of range")
            all_indices.extend(i + vertex_offset for i in batch_indices)
            vertex_offset += vcnt

        chunk_records.append((first_vert, index_start, len(all_indices) - index_start, chunk_z, chunk_x))

    return {
        "positions": positions,
        "colors": colors,
        "uvs": uvs,
        "indices": all_indices,
        "chunks": chunk_records,
    }

def write_binary_mesh(filepath, mesh):
    vcount = len(mesh["positions"]) // 3
    icount = len(mesh["indices"])
    for arr in (mesh["positions"], mesh["colors"], mesh["uvs"]):
        assert arr.itemsize == 4
    assert mesh["indices"].itemsize == 4
    with open(filepath, "wb") as f:
        f.write(b"TRRN")
        f.write(struct.pack("<III", vcount, icount, len(mesh["chunks"])))
        mesh["positions"].tofile(f)
        mesh["colors"].tofile(f)
        mesh["uvs"].tofile(f)
        mesh["indices"].tofile(f)
        for first_vert, index_start, index_count, z, x in mesh["chunks"]:
            f.write(struct.pack("<IIIii", first_vert, index_start, index_count, z, x))

def main():
    parser = argparse.ArgumentParser(description="Convert Forgelight CNK terrain to mesh")
    parser.add_argument("assets_dir", help="Directory with .cnk1 files and .zone file")
    parser.add_argument("--output", "-o", default=None, help="Output directory")
    args = parser.parse_args()

    assets_dir = Path(args.assets_dir)
    output_dir = Path(args.output) if args.output else assets_dir / "terrain"
    output_dir.mkdir(parents=True, exist_ok=True)

    dll = load_lzham_dll()

    zone_files = list(assets_dir.glob("*.zone"))
    if not zone_files:
        print(f"ERROR: No .zone file in {assets_dir}")
        sys.exit(1)
    zone_params = parse_zone_header(zone_files[0])
    print(f"Zone: tileSize={zone_params['tileSize']}, tilesPerChunk={zone_params['tilesPerChunk']}")
    print(f"  ChunksX={zone_params['chunksX']}, ChunksY={zone_params['chunksY']}")
    print(f"  StartX={zone_params['startX']}, StartY={zone_params['startY']}")

    cnk_files = sorted(glob.glob(str(assets_dir / "*.cnk1")))
    if not cnk_files:
        print(f"ERROR: No .cnk1 files in {assets_dir}")
        sys.exit(1)

    print(f"Found {len(cnk_files)} CNK1 chunks")

    chunk_data_list = []
    chunk_coords_list = []
    failed = []

    for n, path in enumerate(cnk_files):
        name = os.path.basename(path)
        z, x = chunk_coords_from_filename(name)
        if z is None:
            continue
        try:
            data = parse_cnk1(dll, path)
            chunk_data_list.append(data)
            chunk_coords_list.append((z, x))
        except Exception as e:
            failed.append(name)
            print(f"  ERROR {name}: {e}")
        if (n + 1) % 128 == 0:
            print(f"  parsed {n + 1}/{len(cnk_files)}")

    if failed:
        print(f"WARNING: {len(failed)} chunks failed to parse: {failed}")
    if not chunk_data_list:
        print("ERROR: No chunks parsed")
        sys.exit(1)

    print("Building combined mesh...")
    mesh = build_terrain_mesh(chunk_data_list, chunk_coords_list)
    print(f"  {len(mesh['positions']) // 3} vertices, {len(mesh['indices'])} indices, {len(mesh['chunks'])} chunks")

    out_path = output_dir / "terrain.bin"
    write_binary_mesh(str(out_path), mesh)
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")

    params_path = output_dir / "terrain-params.json"
    with open(params_path, "w") as f:
        json.dump(zone_params, f, indent=2)
    print(f"Wrote {params_path}")

    print("Done!")

if __name__ == "__main__":
    main()
