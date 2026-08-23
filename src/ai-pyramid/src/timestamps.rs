//! One reference frame for every timestamp that reaches the database.
//!
//! Stored values are UTC, formatted `YYYY-MM-DDTHH:MM:SSZ`. The `Z` is the
//! point: an unsuffixed `2026-08-23T22:03:17` says nothing about which clock
//! wrote it, which is how comic timestamps sat an hour off for four months
//! without anything noticing (`docs/investigations/captured-at-timezone.md`).
//! The `created_at` columns already used this format; `captured_at` and
//! `detected_at` now match them.
//!
//! Local time survives in exactly two places, both deliberate: comic filenames
//! carry the camera's local time, and a "day" in the album is a local day —
//! nobody thinks of their cat's morning in UTC.

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

const DB_FORMAT: &str = "%Y-%m-%dT%H:%M:%SZ";
const LEGACY_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

/// Render a timestamp for storage.
pub fn to_db(instant: DateTime<Utc>) -> String {
    instant.format(DB_FORMAT).to_string()
}

/// Now, ready to store.
pub fn now_db() -> String {
    to_db(Utc::now())
}

/// Interpret a naive local timestamp — a comic filename's `YYYYMMDD_HHMMSS`,
/// which the camera renders in its own timezone.
///
/// The camera and this host are assumed to share a timezone. They do (both
/// Asia/Tokyo since 2026-08-23), and JST has no DST, so this never hits an
/// ambiguous or skipped local time. `single()` failing would mean one of those
/// assumptions broke; falling back to treating the value as UTC keeps ingest
/// running rather than dropping the photo.
pub fn from_camera_local(naive: NaiveDateTime) -> DateTime<Utc> {
    match Local.from_local_datetime(&naive).single() {
        Some(local) => local.with_timezone(&Utc),
        None => Utc.from_utc_datetime(&naive),
    }
}

/// Read a stored timestamp. Values without a `Z` predate this module and are
/// local, so they are converted the same way a filename would be.
pub fn parse_db(stored: &str) -> Option<DateTime<Utc>> {
    if let Ok(naive) = NaiveDateTime::parse_from_str(stored, DB_FORMAT) {
        return Some(Utc.from_utc_datetime(&naive));
    }
    NaiveDateTime::parse_from_str(stored, LEGACY_FORMAT)
        .ok()
        .map(from_camera_local)
}

/// Half-open UTC bounds of a local calendar day, for `captured_at >= ? AND < ?`.
///
/// A stored-string comparison works because every stored value uses the same
/// fixed-width UTC format, so lexical order is chronological order.
pub fn local_day_bounds(day: &str) -> Option<(String, String)> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let start = Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .single()?
        .with_timezone(&Utc);
    Some((to_db(start), to_db(start + Duration::days(1))))
}

/// The local calendar day a timestamp belongs to — what a human means by
/// "2026-08-23" when looking at the album.
pub fn local_day_of(instant: DateTime<Utc>) -> String {
    instant.with_timezone(&Local).format("%Y-%m-%d").to_string()
}

/// Stand-in for a timestamp that could not be read: far in the past, so a
/// corrupt row never masquerades as a recent observation.
pub fn epoch() -> DateTime<Utc> {
    DateTime::from_timestamp(0, 0).expect("the epoch is representable")
}

/// Today, locally.
pub fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, LEGACY_FORMAT).unwrap()
    }

    #[test]
    fn stored_values_carry_the_zone() {
        let instant = from_camera_local(naive("2026-08-23T22:03:17"));
        assert!(to_db(instant).ends_with('Z'));
    }

    #[test]
    fn round_trips_through_storage() {
        let instant = from_camera_local(naive("2026-08-23T22:03:17"));
        assert_eq!(parse_db(&to_db(instant)), Some(instant));
    }

    #[test]
    fn legacy_values_are_read_as_local() {
        // A row written before this module: no Z, camera-local.
        let legacy = parse_db("2026-08-23T22:03:17").unwrap();
        let explicit = from_camera_local(naive("2026-08-23T22:03:17"));
        assert_eq!(legacy, explicit);
    }

    #[test]
    fn unparsable_values_are_rejected() {
        assert!(parse_db("yesterday").is_none());
        assert!(parse_db("").is_none());
    }

    #[test]
    fn day_bounds_span_exactly_one_day() {
        let (start, end) = local_day_bounds("2026-08-23").unwrap();
        let start = parse_db(&start).unwrap();
        let end = parse_db(&end).unwrap();
        assert_eq!(end - start, Duration::days(1));
        // Both ends belong to the requested day: start is its first instant,
        // end is the first instant of the next one.
        assert_eq!(local_day_of(start), "2026-08-23");
        assert_eq!(local_day_of(end - Duration::seconds(1)), "2026-08-23");
        assert_eq!(local_day_of(end), "2026-08-24");
    }

    #[test]
    fn day_bounds_are_lexically_ordered() {
        let (start, end) = local_day_bounds("2026-08-23").unwrap();
        assert!(start < end, "{start} must sort before {end}");
        let midday = to_db(from_camera_local(naive("2026-08-23T12:00:00")));
        assert!(start <= midday && midday < end);
    }

    #[test]
    fn day_bounds_reject_junk() {
        assert!(local_day_bounds("2026-13-45").is_none());
        assert!(local_day_bounds("not-a-day").is_none());
    }
}
