# Comic timestamps were an hour behind (rdk-x5 on CST)

Investigation date: 2026-08-23
Devices: rdk-x5 (camera / streaming server), AI Pyramid Pro (pet-album)
Components: `src/streaming_server/internal/webmonitor/comic_capture.go`,
`src/ai-pyramid/src/ingest/filename.rs`

## Symptom

Every time quoted by the album — the album list, the `HH:MM` prefixes in the
daily summary — was about one hour earlier than the wall clock. A comic named
`comic_20260823_220317_mike.jpg` landed on the album host at 23:03:45 JST.

## Cause

The rdk-x5's absolute clock was correct: its HTTP `Date` header (always GMT)
matched the album host's UTC to the second. What differed was the timezone used
to render local time — the camera ran **CST (UTC+8)** while the album host runs
**JST (UTC+9)**.

Comic filenames are built from the camera's local time:

```go
// comic_capture.go:237
cc.sessionID = now.Format("20060102_150405")   // now = time.Now(), system TZ
```

and pet-album derives `photos.captured_at` from that filename
(`ingest/filename.rs: parse_comic_filename`). So the stored timestamp inherited
the camera's timezone.

The same process already had one explicitly-zoned path — the timestamp burned
into the streamed frames uses `time.FixedZone("JST", 9*3600)`
(`broadcaster.go:20`) — so the overlay was right while the filename was wrong.

## Evidence

Comparing each comic's filename timestamp with its file mtime on the album host
(mtime = arrival, in real time):

| metric | value |
|---|---|
| files sampled | 6427 |
| within the 3540–3660s band | 5629 |
| median gap | 3622 s |
| stdev inside the band | 12 s |

A transfer delay would be spread out; a fixed one-hour offset plus ~22 s of
pipeline latency is what this looks like. Grouping the same measure by day also
showed when it started:

- 2026-03-20 .. 2026-04-09 — gaps of seconds (camera was on JST)
- 2026-04-10 onward — gaps of ~1 hour (camera on CST)

## Fix

The camera's timezone was corrected at the source, since nothing on rdk-x5
schedules on local hours (day/night switching is signal-based — `switch_signal.c`
uses `tm` only for log lines — and every unit timer there is `OnBootSec`-relative,
no `OnCalendar`):

```bash
sudo timedatectl set-timezone Asia/Tokyo
sudo reboot
```

Historical rows were then shifted with `scripts/fix_captured_at_timezone.py`,
which derives the affected window from the mtime evidence above rather than
hardcoding dates, and backs the database up before writing. 5632 `photos` rows
moved +60 minutes; rows from the pre-2026-04-10 JST era were left alone.

Shifting moves photos captured in the 23:00 hour across the day boundary, so
per-day counts change: 2026-08-22 went from 21 valid photos to 14, and
2026-08-23 from 35 to 42.

## Aftermath: one reference frame

The investigation surfaced a second discrepancy. `training_frames.captured_at`
was **UTC** — it comes from a Unix timestamp in the frame's JSON metadata via
`DateTime::from_timestamp` (`training/api/frames.rs:33`), so the camera's
timezone never touched it — while `photos.captured_at` was local. Two tables in
the same database, nine hours apart, with nothing in either value saying which
was which. That is the same failure mode as the bug above, so timestamps were
moved to a single stored form: UTC, suffixed `Z`, via `crate::timestamps`.
`PhotoStore::migrate()` converts pre-existing rows, keyed on the missing `Z` so
it cannot shift a value twice.

Local time now survives in exactly two deliberate places: comic filenames (the
camera writes them) and the album's notion of a day (`local_day_bounds`), since
nobody thinks of their cat's morning in UTC.
