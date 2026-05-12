#!/usr/bin/env python3
"""GC for night_collect frame directories on rdk-x5.

Removes old / excess .nv12 frames and their paired .json sidecars while
respecting a min-age floor so in-flight writes by yolo_detector_daemon are
never touched.

See docs/night-collect-gc-plan.md for design rationale.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("night_collect_gc")


@dataclass
class _Entry:
    path: Path
    mtime: float
    size: int


def _scan_nv12(
    directory: Path, now: float, min_age_seconds: float
) -> tuple[list[_Entry], int]:
    """Return (entries eligible for deletion, count of fresh files skipped)."""
    eligible: list[_Entry] = []
    fresh = 0
    for p in directory.iterdir():
        if not p.is_file() or p.suffix != ".nv12":
            continue
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        if now - st.st_mtime < min_age_seconds:
            fresh += 1
            continue
        eligible.append(_Entry(path=p, mtime=st.st_mtime, size=st.st_size))
    return eligible, fresh


def _select_for_deletion(
    eligible: list[_Entry],
    now: float,
    max_age_days: float,
    max_files: int,
) -> list[_Entry]:
    """Return entries to delete: age cutoff ∪ count overflow (oldest first)."""
    eligible.sort(key=lambda e: e.mtime)
    age_threshold = now - max_age_days * 86400.0
    to_delete: list[_Entry] = []
    survivors: list[_Entry] = []
    for e in eligible:
        if e.mtime < age_threshold:
            to_delete.append(e)
        else:
            survivors.append(e)
    if len(survivors) > max_files:
        excess = len(survivors) - max_files
        to_delete.extend(survivors[:excess])
    return to_delete


def _delete_with_sidecar(nv12_path: Path, dry_run: bool) -> tuple[int, int, int]:
    """Delete .nv12 and its .json sibling. Returns (nv12_count, json_count, freed_bytes)."""
    json_path = nv12_path.with_suffix(".json")
    try:
        nv12_size = nv12_path.stat().st_size
    except FileNotFoundError:
        nv12_size = 0
    json_existed = json_path.exists()
    if dry_run:
        logger.info("[dry-run] would delete %s (+sidecar=%s)", nv12_path.name, json_existed)
        return 1 if nv12_size or nv12_path.exists() else 0, 1 if json_existed else 0, nv12_size

    nv12_count = 0
    json_count = 0
    try:
        nv12_path.unlink()
        nv12_count = 1
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.warning("failed to unlink %s: %s", nv12_path, e)
        nv12_size = 0
    if json_existed:
        try:
            json_path.unlink()
            json_count = 1
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("failed to unlink %s: %s", json_path, e)
    return nv12_count, json_count, nv12_size if nv12_count else 0


def _cleanup_orphans(
    directory: Path, now: float, min_age_seconds: float, dry_run: bool
) -> tuple[int, int]:
    """Delete .nv12 / .json files whose counterpart is missing.

    Files newer than min_age_seconds are never touched (protects in-flight
    writes where the NV12 is on disk but the JSON has not yet been written).
    """
    nv12_stems: set[str] = set()
    json_stems: set[str] = set()
    for p in directory.iterdir():
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        if now - st.st_mtime < min_age_seconds:
            continue
        if p.suffix == ".nv12":
            nv12_stems.add(p.stem)
        elif p.suffix == ".json":
            json_stems.add(p.stem)

    deleted_nv12 = 0
    deleted_json = 0
    for stem in nv12_stems - json_stems:
        p = directory / f"{stem}.nv12"
        if dry_run:
            logger.info("[dry-run] would delete orphan %s", p.name)
            deleted_nv12 += 1
            continue
        try:
            p.unlink()
            deleted_nv12 += 1
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("failed to unlink orphan %s: %s", p, e)
    for stem in json_stems - nv12_stems:
        p = directory / f"{stem}.json"
        if dry_run:
            logger.info("[dry-run] would delete orphan %s", p.name)
            deleted_json += 1
            continue
        try:
            p.unlink()
            deleted_json += 1
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("failed to unlink orphan %s: %s", p, e)
    return deleted_nv12, deleted_json


def run(
    directory: Path,
    max_age_days: float,
    max_files: int,
    min_age_seconds: float,
    dry_run: bool,
    now: float | None = None,
) -> dict:
    if now is None:
        now = time.time()
    start = time.monotonic()
    result = {
        "dir": str(directory),
        "dry_run": dry_run,
        "scanned": 0,
        "fresh_skipped": 0,
        "deleted_nv12": 0,
        "deleted_json": 0,
        "freed_bytes": 0,
        "elapsed_ms": 0,
    }
    if not directory.is_dir():
        logger.warning("directory does not exist: %s", directory)
        return result

    eligible, fresh = _scan_nv12(directory, now, min_age_seconds)
    result["scanned"] = len(eligible) + fresh
    result["fresh_skipped"] = fresh

    targets = _select_for_deletion(eligible, now, max_age_days, max_files)
    for entry in targets:
        n, j, freed = _delete_with_sidecar(entry.path, dry_run)
        result["deleted_nv12"] += n
        result["deleted_json"] += j
        result["freed_bytes"] += freed

    orphan_nv12, orphan_json = _cleanup_orphans(
        directory, now, min_age_seconds, dry_run
    )
    result["deleted_nv12"] += orphan_nv12
    result["deleted_json"] += orphan_json

    result["elapsed_ms"] = int((time.monotonic() - start) * 1000)
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="GC night_collect frames")
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--max-age-days", type=float, default=7.0)
    ap.add_argument("--max-files", type=int, default=5000)
    ap.add_argument("--min-age-seconds", type=float, default=60.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--log-json", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    result = run(
        directory=args.dir,
        max_age_days=args.max_age_days,
        max_files=args.max_files,
        min_age_seconds=args.min_age_seconds,
        dry_run=args.dry_run,
    )
    if args.log_json:
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
    else:
        logger.info("done: %s", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
