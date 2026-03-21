use chrono::NaiveDateTime;

#[derive(Debug, Clone, PartialEq)]
pub struct ComicMeta {
    pub captured_at: NaiveDateTime,
    pub pet_id: Option<String>,
}

pub fn parse_comic_filename(name: &str) -> Result<ComicMeta, String> {
    let stem = name.strip_suffix(".jpg")
        .or_else(|| name.strip_suffix(".jpeg"))
        .or_else(|| name.strip_suffix(".JPG"))
        .ok_or_else(|| format!("not a JPEG: {name}"))?;

    if !stem.starts_with("comic_") {
        return Err(format!("not a comic file: {name}"));
    }

    let rest = &stem["comic_".len()..];
    // Expected: YYYYMMDD_HHMMSS or YYYYMMDD_HHMMSS_petid
    let parts: Vec<&str> = rest.splitn(3, '_').collect();
    if parts.len() < 2 {
        return Err(format!("invalid comic filename format: {name}"));
    }

    let datetime_str = format!("{}_{}", parts[0], parts[1]);
    let captured_at = NaiveDateTime::parse_from_str(&datetime_str, "%Y%m%d_%H%M%S")
        .map_err(|e| format!("invalid datetime in {name}: {e}"))?;

    let pet_id = if parts.len() == 3 && !parts[2].is_empty() {
        let pid = parts[2];
        if matches!(pid, "mike" | "chatora" | "other") {
            Some(pid.to_string())
        } else {
            return Err(format!("unknown pet_id '{pid}' in {name}"));
        }
    } else {
        None
    };

    Ok(ComicMeta { captured_at, pet_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
            .and_hms_opt(h, mi, s).unwrap()
    }

    #[test]
    fn parse_with_chatora() {
        let meta = parse_comic_filename("comic_20260321_104532_chatora.jpg").unwrap();
        assert_eq!(meta.captured_at, dt(2026, 3, 21, 10, 45, 32));
        assert_eq!(meta.pet_id.as_deref(), Some("chatora"));
    }

    #[test]
    fn parse_with_mike() {
        let meta = parse_comic_filename("comic_20260321_104532_mike.jpg").unwrap();
        assert_eq!(meta.pet_id.as_deref(), Some("mike"));
    }

    #[test]
    fn parse_with_other() {
        let meta = parse_comic_filename("comic_20260321_104532_other.jpg").unwrap();
        assert_eq!(meta.pet_id.as_deref(), Some("other"));
    }

    #[test]
    fn parse_legacy_no_petid() {
        let meta = parse_comic_filename("comic_20260321_104532.jpg").unwrap();
        assert_eq!(meta.captured_at, dt(2026, 3, 21, 10, 45, 32));
        assert_eq!(meta.pet_id, None);
    }

    #[test]
    fn reject_not_jpeg() {
        assert!(parse_comic_filename("comic_20260321_104532.png").is_err());
    }

    #[test]
    fn reject_not_comic() {
        assert!(parse_comic_filename("photo_20260321_104532.jpg").is_err());
    }

    #[test]
    fn reject_bad_date() {
        assert!(parse_comic_filename("comic_baddate_104532.jpg").is_err());
    }

    #[test]
    fn reject_unknown_petid() {
        assert!(parse_comic_filename("comic_20260321_104532_unknown.jpg").is_err());
    }

    #[test]
    fn accept_uppercase_jpg() {
        let meta = parse_comic_filename("comic_20260321_104532_mike.JPG").unwrap();
        assert_eq!(meta.pet_id.as_deref(), Some("mike"));
    }
}
