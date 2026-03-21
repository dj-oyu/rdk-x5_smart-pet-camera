#!/usr/bin/env python3
"""
H.265 Motion Vector Extraction Test

Two approaches:
1. PyAV: Decode H.265 with export_mvs flag → per-block MV data
2. VPU stats: Read intra_block_num/skip_block_num from encoder output

Usage:
    uv run tests/hw_motion_vector_test.py [video_file.mp4]
    uv run tests/hw_motion_vector_test.py  # uses latest recording
"""

import struct
import sys
import os
import subprocess
import numpy as np
from pathlib import Path


def extract_mvs_pyav(video_path: str, max_frames: int = 60):
    """Extract motion vectors using PyAV with export_mvs."""
    import av

    container = av.open(video_path, options={"flags2": "+export_mvs"})
    stream = container.streams.video[0]

    width, height = stream.width, stream.height
    print(f"Codec: {stream.codec_context.name}, {width}x{height}")
    print()

    grid_w, grid_h = width // 16, height // 16

    for i, frame in enumerate(container.decode(stream)):
        if i >= max_frames:
            break

        ptype = str(frame.pict_type)

        # Try to get motion vectors from side data
        mvs = []
        for sd in frame.side_data or []:
            if hasattr(sd, 'type') and 'MOTION' in str(sd.type).upper():
                raw = bytes(sd)
                mv_size = 32
                for j in range(len(raw) // mv_size):
                    off = j * mv_size
                    entry = raw[off:off + mv_size]
                    source = struct.unpack_from('<i', entry, 0)[0]
                    w, h = entry[4], entry[5]
                    src_x, src_y = struct.unpack_from('<hh', entry, 6)
                    dst_x, dst_y = struct.unpack_from('<hh', entry, 10)
                    motion_x, motion_y = struct.unpack_from('<ii', entry, 24)
                    mvs.append({
                        'w': w, 'h': h,
                        'dst_x': dst_x, 'dst_y': dst_y,
                        'mx': motion_x / 4.0,
                        'my': motion_y / 4.0,
                    })

        if not mvs:
            # Also try direct attribute access (varies by PyAV version)
            try:
                sd_dict = {str(k): v for k, v in frame.side_data.items()} if frame.side_data else {}
                for key, val in sd_dict.items():
                    if 'motion' in key.lower():
                        raw = bytes(val)
                        mv_size = 32
                        for j in range(len(raw) // mv_size):
                            off = j * mv_size
                            entry = raw[off:off + mv_size]
                            motion_x, motion_y = struct.unpack_from('<ii', entry, 24)
                            dst_x, dst_y = struct.unpack_from('<hh', entry, 10)
                            mvs.append({
                                'w': entry[4], 'h': entry[5],
                                'dst_x': dst_x, 'dst_y': dst_y,
                                'mx': motion_x / 4.0,
                                'my': motion_y / 4.0,
                            })
            except Exception:
                pass

        if not mvs:
            print(f"Frame {i:3d} [{ptype:5s}]: no MVs")
            continue

        mags = np.array([np.sqrt(mv['mx']**2 + mv['my']**2) for mv in mvs])

        # Build heatmap
        heatmap = np.zeros((grid_h, grid_w), dtype=np.float32)
        for mv in mvs:
            gx = max(0, min(grid_w - 1, mv['dst_x'] // 16))
            gy = max(0, min(grid_h - 1, mv['dst_y'] // 16))
            heatmap[gy, gx] += np.sqrt(mv['mx']**2 + mv['my']**2)

        motion_thresh = 2.0
        motion_blocks = int(np.sum(heatmap > motion_thresh))
        total = grid_w * grid_h

        print(f"Frame {i:3d} [{ptype:5s}]: "
              f"MVs={len(mvs):5d}  "
              f"avg={mags.mean():5.1f}px  "
              f"max={mags.max():5.1f}px  "
              f"motion={motion_blocks}/{total} ({motion_blocks/total*100:.1f}%)")

        # Save first few heatmaps
        if i < 5:
            save_pgm(heatmap, f"/tmp/mv_heatmap_{i:03d}.pgm", grid_w, grid_h)

    container.close()
    print(f"\nHeatmaps: /tmp/mv_heatmap_*.pgm")


def analyze_h265_nal(video_path: str, max_frames: int = 30):
    """Analyze H.265 NAL units from raw bitstream."""
    print(f"\n=== NAL Analysis: {video_path} ===")

    with open(video_path, 'rb') as f:
        data = f.read(2 * 1024 * 1024)

    nal_types = {}
    frame_sizes = []
    offset = 0
    prev_offset = 0

    while offset < len(data) - 5:
        if data[offset:offset+4] == b'\x00\x00\x00\x01':
            if prev_offset > 0:
                frame_sizes.append(offset - prev_offset)
            prev_offset = offset

            nal_type = (data[offset + 4] >> 1) & 0x3F
            nal_types[nal_type] = nal_types.get(nal_type, 0) + 1
            offset += 5
        else:
            offset += 1

    type_names = {
        0: "TRAIL_N", 1: "TRAIL_R (P-frame, has MVs)",
        19: "IDR_W_RADL (I-frame)", 20: "IDR_N_LP (I-frame)",
        32: "VPS", 33: "SPS", 34: "PPS", 39: "SEI",
    }

    for nt, count in sorted(nal_types.items()):
        name = type_names.get(nt, f"type_{nt}")
        print(f"  {name}: {count}")

    if frame_sizes:
        sizes = np.array(frame_sizes)
        print(f"\nFrame sizes: min={sizes.min()}, max={sizes.max()}, "
              f"avg={sizes.mean():.0f}, std={sizes.std():.0f}")
        print(f"Size variance can indicate motion (large P-frames = more motion)")


def test_live_vpu_stats():
    """Test reading VPU encoder statistics from live camera."""
    print("\n=== VPU Encoder Stats (live test) ===")
    print("To test with live camera, the encoder_thread needs to expose")
    print("output_info.video_stream_info.intra_block_num and skip_block_num")
    print("via SHM or a separate stats channel.")
    print()
    print("Fields available per encoded frame:")
    print("  - intra_block_num: blocks encoded as intra (motion/scene change)")
    print("  - skip_block_num: blocks skipped (no change from reference)")
    print("  - avg_mb_qp: average QP (indirect motion indicator)")
    print("  - enc_pic_byte: encoded frame size (indirect)")
    print()
    print("Proposed approach:")
    print("  1. In encoder_thread worker, after hb_mm_mc_dequeue_output_buffer:")
    print("     - Read output_info.video_stream_info.intra_block_num")
    print("     - Write to a lightweight SHM or Frame metadata")
    print("  2. Python detector reads intra_block_num from SHM")
    print("  3. motion_detected = intra_block_num > threshold")


def save_pgm(heatmap, path, w, h):
    """Save heatmap as PGM."""
    if heatmap.max() > 0:
        norm = (heatmap / heatmap.max() * 255).astype(np.uint8)
    else:
        norm = np.zeros((h, w), dtype=np.uint8)
    with open(path, 'wb') as f:
        f.write(f"P5\n{w} {h}\n255\n".encode())
        f.write(norm.tobytes())


def main():
    if len(sys.argv) > 1:
        video_path = sys.argv[1]
    else:
        recordings = Path("/app/smart-pet-camera/recordings")
        files = sorted(recordings.glob("*.mp4"))
        if not files:
            files = sorted(recordings.glob("*.hevc"))
        if not files:
            print("No recordings found")
            sys.exit(1)
        video_path = str(files[-1])

    print(f"=== H.265 Motion Vector Extraction Test ===")
    print(f"File: {video_path}\n")

    # NAL analysis (always works, no decoder needed)
    analyze_h265_nal(video_path, max_frames=30)

    # Try PyAV MV extraction
    try:
        import av
        print(f"\nPyAV {av.__version__} available")
        extract_mvs_pyav(video_path, max_frames=30)
    except ImportError:
        print("\nPyAV not available. Install with: uv add av")
        print("Falling back to ffmpeg analysis only.")

    # VPU stats info
    test_live_vpu_stats()


if __name__ == "__main__":
    main()
