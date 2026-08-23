#!/usr/bin/env python3
"""Shift pet-album captured_at values that were written in the camera's old timezone.

The rdk-x5 formats comic filenames with its system local time, and pet-album
derives captured_at from that filename. Between 2026-04-10 and 2026-08-23 that
system timezone was CST (UTC+8) while the album host runs JST (UTC+9): the
absolute clock was right, only the local-time rendering was an hour behind, so
every captured_at from that period is an hour early.

The affected window is derived from the data rather than hardcoded. For a photo
still on disk, the gap between its file mtime (when comic-sync landed it, in
real time) and its captured_at label is ~1 hour while the camera ran CST and
~20-40 seconds otherwise. The oldest and newest CST-looking rows bound the
window; every row inside it is shifted, including ones whose own file was
deleted or whose mtime was later rewritten by a copy.

Dry-run by default. `--apply` backs the database up first.
"""

import argparse
import datetime as dt
import shutil
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "src/ai-pyramid/data/pet-album.db"
DEFAULT_PHOTOS = REPO_ROOT / "src/ai-pyramid/data/photos"
TS_FORMATS = ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S")


def parse_ts(value):
    for fmt in TS_FORMATS:
        try:
            return dt.datetime.strptime(value, fmt), fmt
        except (ValueError, TypeError):
            continue
    return None, None


def arrival_gap(directory, filename, captured_at):
    """Seconds between the file landing on disk and its captured_at label."""
    if directory is None or not filename:
        return None
    path = directory / filename
    if not path.exists():
        return None
    return path.stat().st_mtime - captured_at.timestamp()


def load(conn, table, directory, threshold):
    rows = conn.execute(
        f"SELECT id, filename, captured_at FROM {table} WHERE captured_at IS NOT NULL"
    ).fetchall()

    parsed, unparsable = [], []
    for row_id, filename, raw in rows:
        captured_at, fmt = parse_ts(raw)
        if captured_at is None:
            unparsable.append((row_id, filename, raw))
            continue
        gap = arrival_gap(directory, filename, captured_at)
        stale = None if gap is None else gap >= threshold
        parsed.append((row_id, filename, captured_at, fmt, stale))
    return parsed, unparsable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--photos-dir", type=Path, default=DEFAULT_PHOTOS)
    parser.add_argument(
        "--offset-minutes",
        type=int,
        default=60,
        help="how far to move a row inside the window (default: 60)",
    )
    parser.add_argument(
        "--threshold-seconds",
        type=int,
        default=1800,
        help="arrival gap above which a row looks like it was written in the old timezone",
    )
    parser.add_argument(
        "--window",
        nargs=2,
        metavar=("FROM", "TO"),
        help="override the derived window, e.g. --window 2026-04-10T00:00:00 2026-08-23T23:00:00",
    )
    parser.add_argument("--apply", action="store_true", help="write the change")
    args = parser.parse_args()

    if not args.db.exists():
        sys.exit(f"database not found: {args.db}")

    conn = sqlite3.connect(args.db)
    offset = dt.timedelta(minutes=args.offset_minutes)
    # Only `photos` derives captured_at from the camera-local filename.
    # `training_frames.captured_at` comes from a Unix timestamp in the frame's
    # JSON metadata (training/api/frames.rs: DateTime::from_timestamp), so it is
    # UTC and was never touched by the camera's local timezone — leave it alone.
    tables = [("photos", args.photos_dir if args.photos_dir.is_dir() else None)]

    loaded = {
        table: load(conn, table, directory, args.threshold_seconds)
        for table, directory in tables
    }

    if args.window:
        window_from = parse_ts(args.window[0])[0]
        window_to = parse_ts(args.window[1])[0]
        if window_from is None or window_to is None:
            sys.exit("--window needs two YYYY-MM-DDTHH:MM:SS values")
    else:
        stale_times = [
            entry[2]
            for parsed, _ in loaded.values()
            for entry in parsed
            if entry[4] is True
        ]
        if not stale_times:
            print("no rows look like they were written in the old timezone — nothing to do")
            return
        window_from, window_to = min(stale_times), max(stale_times)

    print(f"database: {args.db}")
    print(f"window:   {window_from}  ..  {window_to}  (+{args.offset_minutes} min)")

    total = 0
    plans = {}
    for table, (parsed, unparsable) in loaded.items():
        inside = [e for e in parsed if window_from <= e[2] <= window_to]
        outside_stale = [e for e in parsed if e[4] is True and not (window_from <= e[2] <= window_to)]
        disagree = [e for e in inside if e[4] is False]
        no_file = [e for e in inside if e[4] is None]
        plans[table] = inside
        total += len(inside)

        print(f"\n{table}: shift {len(inside)} of {len(parsed)} rows")
        if inside:
            inside.sort(key=lambda entry: entry[2])
            print(f"  oldest: {inside[0][2]}  ({inside[0][1]})")
            print(f"  newest: {inside[-1][2]}  ({inside[-1][1]}) -> {inside[-1][2] + offset}")
        if no_file:
            print(f"  {len(no_file)} of them have no file on disk (decided by the window)")
        if disagree:
            print(f"  {len(disagree)} look current by mtime but sit inside the window:")
            for entry in disagree[:5]:
                print(f"    id={entry[0]} {entry[1]} {entry[2]}")
        if outside_stale:
            print(f"  WARNING: {len(outside_stale)} stale-looking rows fall outside the window:")
            for entry in outside_stale[:5]:
                print(f"    id={entry[0]} {entry[1]} {entry[2]}")
        for row_id, filename, raw in unparsable:
            print(f"  UNPARSABLE (left as is): id={row_id} {filename} {raw!r}")

    if not args.apply:
        print(f"\ndry run — {total} rows would move +{args.offset_minutes} minutes")
        print("re-run with --apply (stop pet-album.service first) to write it")
        return

    backup = args.db.with_name(
        f"{args.db.name}.bak-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    )
    shutil.copy2(args.db, backup)
    print(f"\nbackup: {backup}")

    with conn:
        for table, inside in plans.items():
            for row_id, _, captured_at, fmt, _ in inside:
                conn.execute(
                    f"UPDATE {table} SET captured_at = ? WHERE id = ?",
                    ((captured_at + offset).strftime(fmt), row_id),
                )
    print(f"updated {total} rows (+{args.offset_minutes} minutes)")
    print("restart pet-album.service so the in-memory summary cache is dropped")


if __name__ == "__main__":
    main()
