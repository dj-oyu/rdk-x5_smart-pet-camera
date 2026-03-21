use chrono::NaiveDateTime;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone)]
pub struct Photo {
    pub id: i64,
    pub filename: String,
    pub captured_at: NaiveDateTime,
    pub caption: Option<String>,
    pub is_valid: Option<bool>,
    pub pet_id: Option<String>,
    pub behavior: Option<String>,
}

#[derive(Debug, Default)]
pub struct PhotoFilter {
    pub is_valid: Option<bool>,
    pub pet_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub struct PhotoStore {
    conn: Connection,
}

impl PhotoStore {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Ok(Self { conn })
    }

    pub fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS photos (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                filename    TEXT    NOT NULL UNIQUE,
                captured_at TEXT    NOT NULL,
                caption     TEXT,
                is_valid    INTEGER,
                pet_id      TEXT,
                behavior    TEXT,
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_photos_valid_captured
                ON photos(is_valid, captured_at DESC);
            CREATE INDEX IF NOT EXISTS idx_photos_pet_id
                ON photos(pet_id, captured_at DESC);",
        )
    }

    pub fn insert(
        &self,
        filename: &str,
        captured_at: NaiveDateTime,
        pet_id: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let ts = captured_at.format("%Y-%m-%dT%H:%M:%S").to_string();
        self.conn.execute(
            "INSERT OR IGNORE INTO photos (filename, captured_at, pet_id) VALUES (?1, ?2, ?3)",
            params![filename, ts, pet_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn update_vlm_result(
        &self,
        filename: &str,
        is_valid: bool,
        caption: &str,
        behavior: &str,
    ) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE photos SET is_valid = ?1, caption = ?2, behavior = ?3 WHERE filename = ?4",
            params![is_valid, caption, behavior, filename],
        )
    }

    pub fn get_by_filename(&self, filename: &str) -> rusqlite::Result<Option<Photo>> {
        self.conn
            .query_row(
                "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior
                 FROM photos WHERE filename = ?1",
                params![filename],
                |row| row_to_photo(row),
            )
            .optional()
    }

    pub fn list(&self, filter: &PhotoFilter) -> rusqlite::Result<(Vec<Photo>, i64)> {
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(valid) = filter.is_valid {
            where_clauses.push("is_valid = ?");
            param_values.push(Box::new(valid));
        }
        if let Some(ref pid) = filter.pet_id {
            where_clauses.push("pet_id = ?");
            param_values.push(Box::new(pid.clone()));
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // Count
        let count_sql = format!("SELECT COUNT(*) FROM photos {where_sql}");
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let total: i64 = self.conn.query_row(&count_sql, params_ref.as_slice(), |r| r.get(0))?;

        // Query
        let limit = filter.limit.unwrap_or(50);
        let offset = filter.offset.unwrap_or(0);
        let query_sql = format!(
            "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior
             FROM photos {where_sql} ORDER BY captured_at DESC LIMIT ? OFFSET ?"
        );
        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = param_values;
        all_params.push(Box::new(limit));
        all_params.push(Box::new(offset));
        let all_ref: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = self.conn.prepare(&query_sql)?;
        let photos = stmt
            .query_map(all_ref.as_slice(), |row| row_to_photo(row))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok((photos, total))
    }

    pub fn count_pending(&self) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM photos WHERE is_valid IS NULL",
            [],
            |r| r.get(0),
        )
    }

    pub fn stats(&self) -> rusqlite::Result<Stats> {
        let total: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))?;
        let valid: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid = 1", [], |r| r.get(0))?;
        let invalid: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid = 0", [], |r| r.get(0))?;
        let pending: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid IS NULL", [], |r| r.get(0))?;
        Ok(Stats { total, valid, invalid, pending })
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Stats {
    pub total: i64,
    pub valid: i64,
    pub invalid: i64,
    pub pending: i64,
}

fn row_to_photo(row: &rusqlite::Row) -> rusqlite::Result<Photo> {
    let captured_str: String = row.get(2)?;
    let captured_at = NaiveDateTime::parse_from_str(&captured_str, "%Y-%m-%dT%H:%M:%S")
        .unwrap_or_default();
    let is_valid_int: Option<i32> = row.get(4)?;
    Ok(Photo {
        id: row.get(0)?,
        filename: row.get(1)?,
        captured_at,
        caption: row.get(3)?,
        is_valid: is_valid_int.map(|v| v != 0),
        pet_id: row.get(5)?,
        behavior: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, s).unwrap()
    }

    fn setup() -> PhotoStore {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        store
    }

    #[test]
    fn migrate_is_idempotent() {
        let store = setup();
        store.migrate().unwrap(); // second call should not fail
    }

    #[test]
    fn insert_and_get() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 45, 32);
        store.insert("comic_20260321_104532_chatora.jpg", ts, Some("chatora")).unwrap();

        let photo = store.get_by_filename("comic_20260321_104532_chatora.jpg").unwrap().unwrap();
        assert_eq!(photo.filename, "comic_20260321_104532_chatora.jpg");
        assert_eq!(photo.captured_at, ts);
        assert_eq!(photo.pet_id.as_deref(), Some("chatora"));
        assert_eq!(photo.is_valid, None); // unprocessed
        assert_eq!(photo.caption, None);
    }

    #[test]
    fn insert_duplicate_is_ignored() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 45, 32);
        store.insert("comic_test.jpg", ts, None).unwrap();
        store.insert("comic_test.jpg", ts, None).unwrap(); // no error
    }

    #[test]
    fn update_vlm_result() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 45, 32);
        store.insert("comic_test.jpg", ts, None).unwrap();
        store.update_vlm_result("comic_test.jpg", true, "A tabby cat resting", "resting").unwrap();

        let photo = store.get_by_filename("comic_test.jpg").unwrap().unwrap();
        assert_eq!(photo.is_valid, Some(true));
        assert_eq!(photo.caption.as_deref(), Some("A tabby cat resting"));
        assert_eq!(photo.behavior.as_deref(), Some("resting"));
    }

    #[test]
    fn list_with_filters() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
        store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), Some("mike")).unwrap();
        store.insert("c.jpg", dt(2026, 3, 21, 12, 0, 0), Some("chatora")).unwrap();

        store.update_vlm_result("a.jpg", true, "cap a", "resting").unwrap();
        store.update_vlm_result("b.jpg", false, "cap b", "other").unwrap();
        store.update_vlm_result("c.jpg", true, "cap c", "eating").unwrap();

        // All
        let (photos, total) = store.list(&PhotoFilter::default()).unwrap();
        assert_eq!(total, 3);
        assert_eq!(photos.len(), 3);
        assert_eq!(photos[0].filename, "c.jpg"); // newest first

        // Valid only
        let (photos, total) = store.list(&PhotoFilter { is_valid: Some(true), ..Default::default() }).unwrap();
        assert_eq!(total, 2);
        assert_eq!(photos.len(), 2);

        // By pet_id
        let (photos, total) = store.list(&PhotoFilter { pet_id: Some("chatora".into()), ..Default::default() }).unwrap();
        assert_eq!(total, 2);
        assert_eq!(photos[0].pet_id.as_deref(), Some("chatora"));

        // Pagination
        let (photos, total) = store.list(&PhotoFilter { limit: Some(1), offset: Some(1), ..Default::default() }).unwrap();
        assert_eq!(total, 3);
        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0].filename, "b.jpg");
    }

    #[test]
    fn count_pending() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None).unwrap();
        assert_eq!(store.count_pending().unwrap(), 2);

        store.update_vlm_result("a.jpg", true, "cap", "resting").unwrap();
        assert_eq!(store.count_pending().unwrap(), 1);
    }

    #[test]
    fn stats_counts() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None).unwrap();
        store.insert("c.jpg", dt(2026, 3, 21, 12, 0, 0), None).unwrap();
        store.update_vlm_result("a.jpg", true, "cap", "resting").unwrap();
        store.update_vlm_result("b.jpg", false, "cap", "other").unwrap();

        let s = store.stats().unwrap();
        assert_eq!(s.total, 3);
        assert_eq!(s.valid, 1);
        assert_eq!(s.invalid, 1);
        assert_eq!(s.pending, 1);
    }
}
