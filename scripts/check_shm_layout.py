#!/usr/bin/env python3
"""
scripts/check_shm_layout.py - Guard the SHM struct *layout* (offsets/sizes)

scripts/check_shm_constants.py already guards scalar constants and SHM
segment names across C / Python / Go. This script guards the one thing that
check does not: whether the Python ctypes mirrors in
src/capture/real_shared_memory.py describe the *same byte layout* as the C
structs they claim to mirror in src/capture/shared_memory.h.

A drift here does not fail a build. It produces a process that silently
decodes the wrong bytes at runtime (e.g. reads `width` out of what is
actually `height`'s bytes) — the single "silently misreads memory" risk
this project has, since Go reads shared_memory.h directly via cgo and never
hand-mirrors it.

How this works (two-tier, because CI is x86_64 and the target is aarch64):

  1. Python side: import the ctypes Structure subclasses from
     real_shared_memory.py and read each field's `.offset` plus
     `ctypes.sizeof()` for its type, and `ctypes.sizeof()` for the whole
     struct.
  2. C side ("device dump"): compile and run
     tools/shm_layout/dump_layout.c, which #includes shared_memory.h
     directly and prints offsetof()/sizeof() for the same fields, using the
     same compiler flags as src/capture/Makefile (parsed from that
     Makefile, not duplicated by hand). This only runs when a C compiler
     that can build against shared_memory.h is actually available; when it
     is not (e.g. most CI runners), this step is skipped and reported as
     such rather than failing the whole gate.
  3. Fixture: tools/shm_layout/expected_layout.json is a C-side dump
     captured once on real hardware and committed to the repo. This is what
     CI compares the Python mirrors against when it cannot build C itself.

Comparisons performed:
  - Python  vs  committed fixture   (always — this is what CI relies on)
  - Python  vs  fresh C device dump (only when a C dump is available —
    authoritative, catches drift the fixture itself doesn't yet reflect)
  - fresh C device dump vs fixture  (only when a C dump is available —
    flags a stale fixture that needs regenerating with --update-expected)

Field comparison is by field *name*, not position: two structs of equal
sizeof() can still disagree if two same-size fields were reordered (e.g.
`width`/`height` swapped in the Python mirror) — the total size stays the
same but each field's offset relative to its name changes, so a
size-of()-only check would miss it. This script keys every check on field
name specifically to catch that case.

This script never creates, writes, or removes any /dev/shm segment, and the
compiled dump_layout binary never touches /dev/shm either — it only reads
compile-time struct layout via offsetof()/sizeof(). Safe to run against a
live device.

Usage:
    python3 scripts/check_shm_layout.py [--verbose]
    python3 scripts/check_shm_layout.py --update-expected   # regenerate the
                                                             # fixture from a
                                                             # fresh device
                                                             # dump (requires
                                                             # a working C
                                                             # dump)

Exit status:
    0  all available comparisons agree
    1  a layout mismatch was found
    2  a source file could not be parsed / an unexpected tool error occurred
"""

from __future__ import annotations

import argparse
import ctypes
import json
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CAPTURE_DIR = PROJECT_ROOT / "src" / "capture"
CAPTURE_MAKEFILE = CAPTURE_DIR / "Makefile"
SHARED_MEMORY_H = CAPTURE_DIR / "shared_memory.h"

LAYOUT_DIR = PROJECT_ROOT / "tools" / "shm_layout"
DUMP_SOURCE = LAYOUT_DIR / "dump_layout.c"
EXPECTED_FIXTURE = LAYOUT_DIR / "expected_layout.json"

# sys.path setup mirrors scripts/profile_shm.py: real_shared_memory.py
# imports `from common.types import DetectionDict`, so both roots are
# required.
sys.path.insert(0, str(CAPTURE_DIR))
sys.path.insert(0, str(PROJECT_ROOT / "src" / "common" / "src"))


class ToolError(Exception):
    """Raised for environment/parsing failures unrelated to a real drift."""


# ============================================================================
# Struct catalogue: (C struct tag used in dump_layout.c's JSON output,
# Python ctypes Structure subclass from real_shared_memory.py)
# ============================================================================

def load_python_structs():
    from real_shared_memory import (  # noqa: PLC0415
        CBoundingBox,
        CDetection,
        CH265ZeroCopyBuffer,
        CH265ZeroCopyFrame,
        CLatestDetectionResult,
        CTimespec,
        CZeroCopyFrame,
        CZeroCopyFrameBuffer,
    )

    return [
        ("timespec", CTimespec),
        ("ZeroCopyFrame", CZeroCopyFrame),
        ("ZeroCopyFrameBuffer", CZeroCopyFrameBuffer),
        ("DetectionBBox", CBoundingBox),
        ("DetectionEntry", CDetection),
        ("LatestDetectionResult", CLatestDetectionResult),
        ("H265ZeroCopyFrame", CH265ZeroCopyFrame),
        ("H265ZeroCopyBuffer", CH265ZeroCopyBuffer),
    ]


def python_layout() -> dict[str, dict]:
    """Build the same {struct_name: {"sizeof":.., "fields":[...]}} shape as
    dump_layout.c's JSON, but from ctypes introspection.
    """
    try:
        structs = load_python_structs()
    except ImportError as exc:
        raise ToolError(f"could not import real_shared_memory.py: {exc}") from exc

    layout: dict[str, dict] = {}
    for name, cls in structs:
        fields = []
        for field_name, field_type in cls._fields_:
            offset = getattr(cls, field_name).offset
            size = ctypes.sizeof(field_type)
            fields.append({"name": field_name, "offset": offset, "size": size})
        layout[name] = {"sizeof": ctypes.sizeof(cls), "fields": fields}
    return layout


# ============================================================================
# C-side device dump: parse src/capture/Makefile's own CC/CFLAGS/CPPFLAGS so
# this never hand-duplicates a second copy of the capture build's compiler
# flags, then compile+run tools/shm_layout/dump_layout.c into a scratch dir.
# ============================================================================

_MAKEVAR_RE = re.compile(r"^(CC|CFLAGS|CPPFLAGS)\s*:?=\s*(.*)$")


def parse_capture_makefile_flags() -> dict[str, str]:
    if not CAPTURE_MAKEFILE.is_file():
        raise ToolError(f"capture Makefile not found: {CAPTURE_MAKEFILE}")
    flags: dict[str, str] = {}
    for line in CAPTURE_MAKEFILE.read_text(encoding="utf-8").splitlines():
        m = _MAKEVAR_RE.match(line)
        if m:
            flags[m.group(1)] = m.group(2).strip()
    missing = {"CC", "CFLAGS", "CPPFLAGS"} - flags.keys()
    if missing:
        raise ToolError(
            f"could not find {sorted(missing)} in {CAPTURE_MAKEFILE} "
            "(script parses these to stay in sync with the capture build's "
            "compiler flags — update the regex if the Makefile changed shape)"
        )
    return flags


def try_build_and_run_device_dump(verbose: bool = False) -> tuple[Optional[dict], str]:
    """Returns (layout_or_None, status_message).

    layout is None when a compiler could not be found at all (treated as a
    normal, expected skip — e.g. most CI runners). Any other failure after a
    compiler *was* found (a real compile error against the current
    shared_memory.h) raises ToolError, since that is a genuine problem, not
    an environment limitation.
    """
    if not DUMP_SOURCE.is_file():
        raise ToolError(f"dump tool source missing: {DUMP_SOURCE}")
    if not SHARED_MEMORY_H.is_file():
        raise ToolError(f"shared_memory.h not found: {SHARED_MEMORY_H}")

    flags = parse_capture_makefile_flags()
    cc = flags["CC"].strip() or "cc"

    if shutil.which(cc) is None:
        return None, f"compiler {cc!r} not found on PATH — skipping device dump"

    cflags = flags["CFLAGS"].split()
    cppflags = flags["CPPFLAGS"].split()

    with tempfile.TemporaryDirectory(prefix="shm_layout_dump_") as tmpdir:
        out_bin = Path(tmpdir) / "dump_layout"
        cmd = (
            [cc]
            + cflags
            + cppflags
            + ["-I", str(CAPTURE_DIR)]  # locate "shared_memory.h" (quote-included)
            + [str(DUMP_SOURCE), "-o", str(out_bin)]
        )
        if verbose:
            print(f"[check-shm-layout] building device dump: {' '.join(cmd)}", file=sys.stderr)
        build = subprocess.run(cmd, capture_output=True, text=True)
        if build.returncode != 0:
            raise ToolError(
                f"{cc} found on PATH but failed to build {DUMP_SOURCE} against "
                f"the current shared_memory.h — this usually means the header "
                f"changed shape in a way the dump tool doesn't know about yet.\n"
                f"--- compiler stderr ---\n{build.stderr}"
            )

        run = subprocess.run([str(out_bin)], capture_output=True, text=True)
        if run.returncode != 0:
            raise ToolError(
                f"dump_layout ran but exited {run.returncode}\n"
                f"--- stderr ---\n{run.stderr}"
            )

        try:
            parsed = json.loads(run.stdout)
        except json.JSONDecodeError as exc:
            raise ToolError(f"dump_layout produced invalid JSON: {exc}\n{run.stdout}") from exc

    layout = {s["name"]: {"sizeof": s["sizeof"], "fields": s["fields"]} for s in parsed["structs"]}
    arch = platform.machine()
    return layout, f"built and ran device dump OK (arch={arch}, compiler={cc})"


# ============================================================================
# Fixture I/O
# ============================================================================

def load_fixture() -> dict[str, dict]:
    if not EXPECTED_FIXTURE.is_file():
        raise ToolError(
            f"committed fixture not found: {EXPECTED_FIXTURE} — generate it on real "
            "hardware with --update-expected and commit it"
        )
    data = json.loads(EXPECTED_FIXTURE.read_text(encoding="utf-8"))
    return {s["name"]: {"sizeof": s["sizeof"], "fields": s["fields"]} for s in data["structs"]}


def write_fixture(layout: dict[str, dict]) -> None:
    structs = [
        {"name": name, "sizeof": info["sizeof"], "fields": info["fields"]}
        for name, info in layout.items()
    ]
    payload = {
        "_meta": {
            "generated_by": "scripts/check_shm_layout.py --update-expected",
            "arch": platform.machine(),
            "platform": platform.platform(),
            "note": (
                "C-side offsetof()/sizeof() dump of the structs in "
                "src/capture/shared_memory.h, captured on real hardware. "
                "Used by CI (which cannot build against shared_memory.h) as "
                "the expected layout to check the Python ctypes mirrors in "
                "src/capture/real_shared_memory.py against. Regenerate with "
                "'python3 scripts/check_shm_layout.py --update-expected' on "
                "the real device whenever shared_memory.h's struct layouts "
                "change, and commit the result."
            ),
        },
        "structs": structs,
    }
    EXPECTED_FIXTURE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


# ============================================================================
# Comparison
# ============================================================================

def compare_layouts(expected: dict[str, dict], actual: dict[str, dict],
                     expected_label: str, actual_label: str) -> list[str]:
    """Field-name-keyed comparison. Returns a list of human-readable
    mismatch descriptions (empty list == agreement).
    """
    errors: list[str] = []

    expected_names = set(expected)
    actual_names = set(actual)
    for missing in sorted(expected_names - actual_names):
        errors.append(f"struct {missing!r}: present in {expected_label}, missing from {actual_label}")
    for extra in sorted(actual_names - expected_names):
        errors.append(f"struct {extra!r}: present in {actual_label}, missing from {expected_label}")

    for struct_name in sorted(expected_names & actual_names):
        exp = expected[struct_name]
        act = actual[struct_name]

        exp_fields = {f["name"]: f for f in exp["fields"]}
        act_fields = {f["name"]: f for f in act["fields"]}

        exp_field_names = set(exp_fields)
        act_field_names = set(act_fields)

        for missing in sorted(exp_field_names - act_field_names):
            errors.append(
                f"{struct_name}.{missing}: present in {expected_label}, missing from {actual_label}"
            )
        for extra in sorted(act_field_names - exp_field_names):
            errors.append(
                f"{struct_name}.{extra}: present in {actual_label}, missing from {expected_label}"
            )

        for field_name in sorted(exp_field_names & act_field_names):
            ef = exp_fields[field_name]
            af = act_fields[field_name]
            if ef["offset"] != af["offset"] or ef["size"] != af["size"]:
                errors.append(
                    f"{struct_name}.{field_name}: {expected_label} offset={ef['offset']} "
                    f"size={ef['size']}  vs  {actual_label} offset={af['offset']} "
                    f"size={af['size']}"
                )

        if exp["sizeof"] != act["sizeof"]:
            errors.append(
                f"{struct_name}: sizeof mismatch — {expected_label}={exp['sizeof']} "
                f"vs {actual_label}={act['sizeof']}"
            )

    return errors


# ============================================================================
# Main
# ============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verbose", action="store_true", help="Print every checked struct/field")
    parser.add_argument(
        "--update-expected",
        action="store_true",
        help="Regenerate tools/shm_layout/expected_layout.json from a fresh device dump "
             "(requires a C compiler that can build shared_memory.h) and exit. Run this on "
             "real hardware after a shared_memory.h layout change, then commit the result.",
    )
    args = parser.parse_args()

    try:
        py_layout = python_layout()
    except ToolError as exc:
        print(f"[check-shm-layout] ERROR: {exc}", file=sys.stderr)
        return 2

    try:
        device_layout, device_status = try_build_and_run_device_dump(verbose=args.verbose)
    except ToolError as exc:
        print(f"[check-shm-layout] ERROR: {exc}", file=sys.stderr)
        return 2

    if args.update_expected:
        if device_layout is None:
            print(f"[check-shm-layout] ERROR: cannot --update-expected: {device_status}", file=sys.stderr)
            return 2
        write_fixture(device_layout)
        print(f"[check-shm-layout] wrote {EXPECTED_FIXTURE.relative_to(PROJECT_ROOT)} ({device_status})")
        return 0

    try:
        fixture_layout = load_fixture()
    except ToolError as exc:
        print(f"[check-shm-layout] ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"[check-shm-layout] device dump: {device_status}")

    all_errors: list[tuple[str, list[str]]] = []

    py_vs_fixture = compare_layouts(fixture_layout, py_layout, "fixture", "python")
    all_errors.append(("python vs committed fixture (tools/shm_layout/expected_layout.json)", py_vs_fixture))

    if device_layout is not None:
        py_vs_device = compare_layouts(device_layout, py_layout, "device(fresh C build)", "python")
        all_errors.append(("python vs fresh C device dump (authoritative)", py_vs_device))

        device_vs_fixture = compare_layouts(fixture_layout, device_layout, "fixture", "device(fresh C build)")
        all_errors.append(("fresh C device dump vs committed fixture (fixture freshness)", device_vs_fixture))

    checked_structs = len(py_layout)
    checked_fields = sum(len(v["fields"]) for v in py_layout.values())

    had_errors = False
    for label, errors in all_errors:
        if not errors:
            if args.verbose:
                print(f"  - {label}: OK")
            continue
        had_errors = True
        print(f"[check-shm-layout] MISMATCH in: {label}", file=sys.stderr)
        for err in errors:
            print(f"    FAIL {err}", file=sys.stderr)

    if had_errors:
        print(
            "\n[check-shm-layout] src/capture/shared_memory.h is authoritative. "
            "Update src/capture/real_shared_memory.py's ctypes mirrors to match it, "
            "or (if the fixture itself is stale) regenerate it on real hardware with "
            "'python3 scripts/check_shm_layout.py --update-expected' and commit the result.",
            file=sys.stderr,
        )
        return 1

    print(
        f"[check-shm-layout] OK: {checked_structs} struct(s) / {checked_fields} field(s) agree "
        f"({'python+device+fixture' if device_layout is not None else 'python+fixture only, no device dump'})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
