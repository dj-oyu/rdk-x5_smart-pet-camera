"""Unit tests for scripts/night_collect_gc.py."""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_SCRIPT = REPO_ROOT / "scripts" / "night_collect_gc.py"
_spec = importlib.util.spec_from_file_location("night_collect_gc", _SCRIPT)
assert _spec is not None and _spec.loader is not None
night_collect_gc = importlib.util.module_from_spec(_spec)
sys.modules["night_collect_gc"] = night_collect_gc
_spec.loader.exec_module(night_collect_gc)


def _make_pair(dir_: Path, idx: int, age_seconds: float, nv12_bytes: bytes = b"x" * 100) -> tuple[Path, Path]:
    """Create a {nv12, json} pair with mtime = now - age_seconds."""
    now = time.time()
    nv12 = dir_ / f"feeding_{idx:08d}_1280x720.nv12"
    js = dir_ / f"feeding_{idx:08d}_1280x720.json"
    nv12.write_bytes(nv12_bytes)
    js.write_text("{}")
    mtime = now - age_seconds
    os.utime(nv12, (mtime, mtime))
    os.utime(js, (mtime, mtime))
    return nv12, js


def _set_mtime(path: Path, age_seconds: float) -> None:
    t = time.time() - age_seconds
    os.utime(path, (t, t))


# ---- age cutoff ----

def test_age_cutoff_deletes_old_pairs(tmp_path: Path) -> None:
    old_nv12, old_json = _make_pair(tmp_path, 1, age_seconds=10 * 86400)
    new_nv12, new_json = _make_pair(tmp_path, 2, age_seconds=1 * 86400)

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=7,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert not old_nv12.exists()
    assert not old_json.exists()
    assert new_nv12.exists()
    assert new_json.exists()
    assert result["deleted_nv12"] == 1
    assert result["deleted_json"] == 1
    assert result["scanned"] == 2


def test_age_cutoff_boundary_keeps_files_at_threshold(tmp_path: Path) -> None:
    # mtime just within 7 days → keep
    nv12, _ = _make_pair(tmp_path, 1, age_seconds=7 * 86400 - 3600)

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=7,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert nv12.exists()
    assert result["deleted_nv12"] == 0


# ---- count cap ----

def test_count_cap_removes_oldest(tmp_path: Path) -> None:
    pairs = []
    # five files, each ~1 hour apart, all within age cutoff
    for i in range(5):
        nv12, js = _make_pair(tmp_path, i, age_seconds=3600 * (i + 2))
        pairs.append((nv12, js))

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=30,
        max_files=2,
        min_age_seconds=60,
        dry_run=False,
    )

    # The two NEWEST should survive (i=0 and i=1 have the smallest age)
    assert pairs[0][0].exists() and pairs[0][1].exists()
    assert pairs[1][0].exists() and pairs[1][1].exists()
    # The three OLDEST should be gone
    for i in (2, 3, 4):
        assert not pairs[i][0].exists()
        assert not pairs[i][1].exists()
    assert result["deleted_nv12"] == 3
    assert result["deleted_json"] == 3


# ---- orphan cleanup ----

def test_orphan_nv12_without_json_is_deleted(tmp_path: Path) -> None:
    orphan = tmp_path / "feeding_00000001_1280x720.nv12"
    orphan.write_bytes(b"x")
    _set_mtime(orphan, age_seconds=3600)  # 1h old, outside min-age floor

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=30,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert not orphan.exists()
    assert result["deleted_nv12"] == 1
    assert result["deleted_json"] == 0


def test_orphan_json_without_nv12_is_deleted(tmp_path: Path) -> None:
    orphan = tmp_path / "feeding_00000001_1280x720.json"
    orphan.write_text("{}")
    _set_mtime(orphan, age_seconds=3600)

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=30,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert not orphan.exists()
    assert result["deleted_nv12"] == 0
    assert result["deleted_json"] == 1


# ---- min-age floor ----

def test_min_age_floor_protects_fresh_pair(tmp_path: Path) -> None:
    # 30s old, well within min-age floor (60s)
    nv12, js = _make_pair(tmp_path, 1, age_seconds=30)

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=0.0001,  # would catch anything older than ~10s
        max_files=0,           # would also catch via count cap
        min_age_seconds=60,
        dry_run=False,
    )

    assert nv12.exists()
    assert js.exists()
    assert result["deleted_nv12"] == 0
    assert result["fresh_skipped"] == 1


def test_min_age_floor_protects_inflight_nv12_without_json(tmp_path: Path) -> None:
    """Simulate the race: yolo_detector_daemon wrote NV12 just now, JSON not yet.

    Orphan scanner must NOT delete a fresh NV12 even though it has no JSON.
    """
    fresh_nv12 = tmp_path / "feeding_00000001_1280x720.nv12"
    fresh_nv12.write_bytes(b"x")
    _set_mtime(fresh_nv12, age_seconds=5)  # written 5s ago

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=30,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert fresh_nv12.exists()
    assert result["deleted_nv12"] == 0


# ---- dry-run ----

def test_dry_run_does_not_delete(tmp_path: Path) -> None:
    nv12, js = _make_pair(tmp_path, 1, age_seconds=10 * 86400)

    result = night_collect_gc.run(
        directory=tmp_path,
        max_age_days=7,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=True,
    )

    assert nv12.exists()
    assert js.exists()
    # Counters still report what WOULD be deleted
    assert result["deleted_nv12"] == 1
    assert result["deleted_json"] == 1


# ---- robustness ----

def test_missing_directory_is_noop(tmp_path: Path) -> None:
    result = night_collect_gc.run(
        directory=tmp_path / "does-not-exist",
        max_age_days=7,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )
    assert result["scanned"] == 0
    assert result["deleted_nv12"] == 0


def test_ignores_unrelated_files(tmp_path: Path) -> None:
    """feeding_events.jsonl and other non-(.nv12|.json) files must be left alone."""
    log = tmp_path / "feeding_events.jsonl"
    log.write_text('{"event":"start"}\n')
    _set_mtime(log, age_seconds=30 * 86400)  # very old
    other = tmp_path / "README.txt"
    other.write_text("hello")
    _set_mtime(other, age_seconds=30 * 86400)

    night_collect_gc.run(
        directory=tmp_path,
        max_age_days=7,
        max_files=10_000,
        min_age_seconds=60,
        dry_run=False,
    )

    assert log.exists()
    assert other.exists()
