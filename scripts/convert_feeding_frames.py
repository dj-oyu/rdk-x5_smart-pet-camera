#!/usr/bin/env python3
"""
scripts/convert_feeding_frames.py — re-encode collected feeding frames as WebP

The detector used to store raw NV12 (1.32 MB per 1280x720 frame); it now stores
the luma plane as lossless WebP (~0.5 MB). This converts the frames collected
under the old format so the whole dataset is one shape and the directory stops
holding several times the bytes it needs.

Safety, in order of importance:

  * **Lossless, and verified per file.** The WebP is decoded back and compared
    against the source luma plane pixel for pixel. A file whose round-trip is
    not exact is left untouched and reported.
  * **The original is removed only after the replacement is on disk and
    verified.** The new file is written to a temp name and renamed into place,
    so an interrupted run never leaves a half-written frame.
  * **Gentle by default.** This runs on the device that is also capturing video
    and running inference. It sleeps between files and can be told to stop after
    a while; interrupting it is safe and it resumes where it left off.
  * **The JSON sidecar is left alone** — its name is derived from the stem, so
    it keeps pairing with the converted frame.

Chroma is discarded, which is why "lossless" needs a qualifier: the night camera
is effectively monochrome (measured chroma sigma 6-8 against a 0-255 range), and
the annotation pipeline only ever renders luma. What is preserved exactly is the
luma plane, which is the entire usable signal.

Usage:
    uv run scripts/convert_feeding_frames.py --dry-run
    uv run scripts/convert_feeding_frames.py --limit 500
    uv run scripts/convert_feeding_frames.py --sleep 0.2 --max-seconds 3600
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np

DEFAULT_DIR = Path(
    os.environ.get("NIGHT_COLLECT_DIR", "/mnt/petcam-data/night_collect")
) / "feeding"

# feeding_00013775_1280x720.nv12
NAME_RE = re.compile(r"^(?P<stem>.+_(?P<w>\d+)x(?P<h>\d+))\.nv12$")


class Skip(Exception):
    """Raised when a file cannot be converted; the original is left in place."""


def convert_one(path: Path, *, dry_run: bool) -> tuple[int, int]:
    """Convert one .nv12 to .webp. Returns (bytes_before, bytes_after)."""
    m = NAME_RE.match(path.name)
    if not m:
        raise Skip("filename does not carry WIDTHxHEIGHT")

    width, height = int(m.group("w")), int(m.group("h"))
    expected = width * height * 3 // 2
    size = path.stat().st_size
    if size != expected:
        raise Skip(f"size {size} != expected NV12 size {expected}")

    raw = np.fromfile(path, dtype=np.uint8)
    luma = raw[: width * height].reshape(height, width)

    ok, encoded = cv2.imencode(".webp", luma, [cv2.IMWRITE_WEBP_QUALITY, 101])
    if not ok:
        raise Skip("WebP encode failed")

    decoded = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
    if decoded is None or not np.array_equal(decoded, luma):
        raise Skip("round-trip is not lossless")

    if dry_run:
        return size, len(encoded)

    target = path.with_suffix(".webp")
    tmp = path.with_suffix(".webp.tmp")
    tmp.write_bytes(encoded.tobytes())
    os.replace(tmp, target)
    # Only now is the original redundant.
    path.unlink()
    return size, len(encoded)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.15,
        help="Seconds to pause between files (default 0.15). This shares a "
        "device with live capture and inference.",
    )
    parser.add_argument("--limit", type=int, help="Stop after this many files")
    parser.add_argument(
        "--max-seconds", type=float, help="Stop after roughly this long"
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.dir.is_dir():
        print(f"[convert] directory not found: {args.dir}", file=sys.stderr)
        return 2

    pending = sorted(p for p in args.dir.iterdir() if p.suffix == ".nv12")
    total = len(pending)
    if args.limit:
        pending = pending[: args.limit]
    print(f"[convert] {total} .nv12 file(s) remaining, processing {len(pending)}")

    started = time.time()
    done = skipped = 0
    before_bytes = after_bytes = 0
    skips: list[tuple[str, str]] = []

    for i, path in enumerate(pending, start=1):
        if args.max_seconds and time.time() - started > args.max_seconds:
            print(f"[convert] time budget reached, stopping after {i - 1} file(s)")
            break
        try:
            before, after = convert_one(path, dry_run=args.dry_run)
        except Skip as exc:
            skipped += 1
            skips.append((path.name, str(exc)))
            continue
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            skipped += 1
            skips.append((path.name, f"unexpected: {exc}"))
            continue

        done += 1
        before_bytes += before
        after_bytes += after
        if done % 250 == 0:
            saved = (before_bytes - after_bytes) / 1e9
            print(
                f"[convert] {done}/{len(pending)} converted, {saved:.2f} GB freed",
                flush=True,
            )
        if args.sleep:
            time.sleep(args.sleep)

    saved = (before_bytes - after_bytes) / 1e9
    verb = "would convert" if args.dry_run else "converted"
    print(f"[convert] {verb} {done} file(s), {saved:.2f} GB freed, {skipped} skipped")
    if skips:
        print("[convert] skipped (originals left in place):")
        for name, why in skips[:20]:
            print(f"    {name}: {why}")
        if len(skips) > 20:
            print(f"    ... and {len(skips) - 20} more")
    remaining = sum(1 for p in args.dir.iterdir() if p.suffix == ".nv12")
    print(f"[convert] {remaining} .nv12 file(s) still remaining")
    return 0


if __name__ == "__main__":
    sys.exit(main())
