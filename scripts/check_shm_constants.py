#!/usr/bin/env python3
"""
scripts/check_shm_constants.py - Guard the SHM single source of truth

src/capture/shm_constants.h is the authoritative definition of shared-memory
segment names and layout constants. Two other languages carry copies:

  * Python  src/capture/real_shared_memory.py  (ctypes bindings, literal consts)
  * Go      src/streaming_server/**.go         (flag defaults, config defaults)

Nothing enforced that the copies agreed. A silent drift here does not fail a
build — it produces a process reading a segment nobody writes, or ctypes
decoding a struct with the wrong element count.

This check parses all three without importing or building anything, and fails
if a copy disagrees with the header.

Usage:
    python3 scripts/check_shm_constants.py [--verbose]

Exit status:
    0  all copies agree
    1  a mismatch was found
    2  a source file could not be parsed
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

HEADER = PROJECT_ROOT / "src" / "capture" / "shm_constants.h"
PYTHON_BINDINGS = PROJECT_ROOT / "src" / "capture" / "real_shared_memory.py"
GO_ROOT = PROJECT_ROOT / "src" / "streaming_server"

# Constants that must agree wherever they are redefined. Names are the C
# spelling; the Python bindings use the same identifiers.
TRACKED = (
    "SHM_NAME_H265_ZC",
    "SHM_NAME_YOLO_ZC",
    "SHM_NAME_DETECTIONS",
    "SHM_NAME_MJPEG_ZC",
    "SHM_NAME_ROI_ZC_0",
    "SHM_NAME_ROI_ZC_1",
    "RING_BUFFER_SIZE",
    "MAX_DETECTIONS",
    "NUM_CAMERAS",
    "NUM_ROI_REGIONS",
    "ZEROCOPY_MAX_PLANES",
    "HB_MEM_GRAPHIC_BUF_SIZE",
)

# "/pet_camera_..." literals in Go that are deliberately not segment names.
GO_LITERAL_ALLOWLIST: frozenset[str] = frozenset()

_DEFINE_RE = re.compile(
    r"^\s*#define\s+(?P<name>[A-Z_][A-Z0-9_]*)\s+(?P<value>\"[^\"]*\"|-?\d+)"
)
_GO_SHM_LITERAL_RE = re.compile(r"\"(/pet_camera_[A-Za-z0-9_]*)\"")


class Mismatch(Exception):
    """Raised when a source file cannot be parsed at all."""


def parse_header(path: Path) -> dict[str, object]:
    """Extract simple #define constants (string or integer) from a C header."""
    if not path.is_file():
        raise Mismatch(f"header not found: {path}")

    values: dict[str, object] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = _DEFINE_RE.match(line)
        if not m:
            continue
        raw = m.group("value")
        values[m.group("name")] = raw[1:-1] if raw.startswith('"') else int(raw)
    if not values:
        raise Mismatch(f"no #define constants parsed from {path}")
    return values


def parse_python(path: Path) -> dict[str, object]:
    """
    Extract module-level constants without importing the module — importing
    would pull in ctypes bindings and hardware-dependent packages.

    Handles the two shapes that appear:
        NAME = "literal"
        NAME = os.getenv("NAME", "default")   -> the default is what matters
    """
    if not path.is_file():
        raise Mismatch(f"python bindings not found: {path}")

    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:  # pragma: no cover - a broken file is a hard stop
        raise Mismatch(f"could not parse {path}: {exc}") from exc

    values: dict[str, object] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue

        value = node.value
        if isinstance(value, ast.Constant) and isinstance(value.value, (str, int)):
            values[target.id] = value.value
        elif (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Attribute)
            and value.func.attr == "getenv"
            and len(value.args) == 2
            and isinstance(value.args[1], ast.Constant)
        ):
            # Environment override with a compiled-in default: the default is
            # the copy that has to match the header.
            values[target.id] = value.args[1].value
    return values


def scan_go_literals(root: Path) -> dict[str, list[str]]:
    """Collect every "/pet_camera_*" literal in non-test Go sources."""
    found: dict[str, list[str]] = {}
    if not root.is_dir():
        raise Mismatch(f"go root not found: {root}")

    for path in sorted(root.rglob("*.go")):
        if path.name.endswith("_test.go"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:  # pragma: no cover - defensive
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            for literal in _GO_SHM_LITERAL_RE.findall(line):
                rel = path.relative_to(PROJECT_ROOT)
                found.setdefault(literal, []).append(f"{rel}:{lineno}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verbose", action="store_true", help="List every checked constant"
    )
    args = parser.parse_args()

    try:
        header = parse_header(HEADER)
        python = parse_python(PYTHON_BINDINGS)
        go_literals = scan_go_literals(GO_ROOT)
    except Mismatch as exc:
        print(f"[check-shm] ERROR: {exc}", file=sys.stderr)
        return 2

    errors: list[str] = []
    checked = 0

    # --- Python copies must equal the header ---
    for name in TRACKED:
        if name not in header:
            errors.append(
                f"{name}: tracked by this check but not defined in "
                f"{HEADER.relative_to(PROJECT_ROOT)} "
                f"(remove it from TRACKED, or restore the #define)"
            )
            continue
        if name not in python:
            if args.verbose:
                print(f"  - {name}: not mirrored in Python (ok)")
            continue
        checked += 1
        if python[name] != header[name]:
            errors.append(
                f"{name}: header={header[name]!r} but "
                f"{PYTHON_BINDINGS.relative_to(PROJECT_ROOT)}={python[name]!r}"
            )
        elif args.verbose:
            print(f"  - {name}: {header[name]!r} (C == Python)")

    # --- Every SHM name literal in Go must exist in the header ---
    header_names = {v for k, v in header.items() if k.startswith("SHM_NAME_")}
    for literal, sites in sorted(go_literals.items()):
        if literal in GO_LITERAL_ALLOWLIST:
            continue
        checked += 1
        if literal not in header_names:
            errors.append(
                f"{literal!r}: used in Go but no matching #define in "
                f"{HEADER.relative_to(PROJECT_ROOT)} — at {', '.join(sites)}"
            )
        elif args.verbose:
            print(f"  - {literal!r}: in header (Go: {len(sites)} site(s))")

    if errors:
        print("[check-shm] SHM constants disagree across languages:", file=sys.stderr)
        for err in errors:
            print(f"  FAIL {err}", file=sys.stderr)
        print(
            f"\n{HEADER.relative_to(PROJECT_ROOT)} is the single source of truth. "
            "Update the copies to match it.",
            file=sys.stderr,
        )
        return 1

    print(f"[check-shm] OK: {checked} constant(s) agree across C / Python / Go")
    return 0


if __name__ == "__main__":
    sys.exit(main())
