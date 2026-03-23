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

#[derive(Debug, Clone, serde::Serialize)]
pub struct Detection {
    pub id: i64,
    pub photo_id: i64,
    pub panel_index: Option<i32>,
    /// Bbox in comic image coordinates (848x496 space)
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    /// YOLO detection class (e.g. "cat", "dog", "person", "cup")
    pub yolo_class: Option<String>,
    /// UV scatter-based pet identity (e.g. "mike", "chatora", "other")
    pub pet_class: Option<String>,
    /// User manual correction of pet identity
    pub pet_id_override: Option<String>,
    pub confidence: Option<f64>,
    pub detected_at: String,
}

/// Input for ingest API. bbox must be in comic image coordinates.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DetectionInput {
    pub panel_index: Option<i32>,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    pub yolo_class: Option<String>,
    pub pet_class: Option<String>,
    pub confidence: Option<f64>,
    pub detected_at: String,
}

#[derive(Debug, Default)]
pub struct PhotoFilter {
    pub is_valid: Option<bool>,
    pub is_pending: bool,
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
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                filename       TEXT    NOT NULL UNIQUE,
                captured_at    TEXT    NOT NULL,
                caption        TEXT,
                is_valid       INTEGER,
                pet_id         TEXT,
                behavior       TEXT,
                vlm_attempts   INTEGER NOT NULL DEFAULT 0,
                vlm_last_error TEXT,
                created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_photos_valid_captured
                ON photos(is_valid, captured_at DESC);
            CREATE INDEX IF NOT EXISTS idx_photos_pet_id
                ON photos(pet_id, captured_at DESC);",
        )?;
        // Migration for existing DBs without vlm_attempts columns
        let _ = self.conn.execute_batch(
            "ALTER TABLE photos ADD COLUMN vlm_attempts INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE photos ADD COLUMN vlm_last_error TEXT;",
        );

        // Detections table: per-bbox records for pet_id calibration
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS detections (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id        INTEGER NOT NULL REFERENCES photos(id),
                panel_index     INTEGER,
                bbox_x          INTEGER NOT NULL,
                bbox_y          INTEGER NOT NULL,
                bbox_w          INTEGER NOT NULL,
                bbox_h          INTEGER NOT NULL,
                yolo_class      TEXT,
                pet_class       TEXT,
                pet_id_override TEXT,
                confidence      REAL,
                detected_at     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_detections_photo
                ON detections(photo_id);",
        )?;

        Ok(())
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
            "UPDATE photos SET is_valid = ?1, caption = ?2, behavior = ?3, vlm_attempts = vlm_attempts + 1, vlm_last_error = NULL WHERE filename = ?4",
            params![is_valid, caption, behavior, filename],
        )
    }

    pub fn record_vlm_failure(&self, filename: &str, error: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE photos SET vlm_attempts = vlm_attempts + 1, vlm_last_error = ?1 WHERE filename = ?2",
            params![error, filename],
        )
    }

    pub fn set_validation_override(&self, filename: &str, is_valid: bool) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE photos SET is_valid = ?1 WHERE filename = ?2",
            params![is_valid, filename],
        )
    }

    pub fn update_pet_id(&self, filename: &str, pet_id: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE photos SET pet_id = ?1 WHERE filename = ?2",
            params![pet_id, filename],
        )
    }

    /// Insert photo + detections atomically. Returns photo id.
    /// If photo already exists (by filename), adds detections to existing record.
    pub fn ingest_with_detections(
        &self,
        filename: &str,
        captured_at: NaiveDateTime,
        pet_id: Option<&str>,
        detections: &[DetectionInput],
    ) -> rusqlite::Result<i64> {
        let ts = captured_at.format("%Y-%m-%dT%H:%M:%S").to_string();

        // Upsert photo
        self.conn.execute(
            "INSERT OR IGNORE INTO photos (filename, captured_at, pet_id) VALUES (?1, ?2, ?3)",
            params![filename, ts, pet_id],
        )?;
        let photo_id: i64 = self.conn.query_row(
            "SELECT id FROM photos WHERE filename = ?1",
            params![filename],
            |row| row.get(0),
        )?;

        // Update pet_id if photo existed without one
        if pet_id.is_some() {
            self.conn.execute(
                "UPDATE photos SET pet_id = COALESCE(pet_id, ?1) WHERE id = ?2",
                params![pet_id, photo_id],
            )?;
        }

        // Insert detections
        let mut stmt = self.conn.prepare(
            "INSERT INTO detections (photo_id, panel_index, bbox_x, bbox_y, bbox_w, bbox_h, yolo_class, pet_class, confidence, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for d in detections {
            stmt.execute(params![
                photo_id,
                d.panel_index,
                d.bbox_x,
                d.bbox_y,
                d.bbox_w,
                d.bbox_h,
                d.yolo_class,
                d.pet_class,
                d.confidence,
                d.detected_at,
            ])?;
        }

        Ok(photo_id)
    }

    pub fn get_detections(&self, photo_id: i64) -> rusqlite::Result<Vec<Detection>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, photo_id, panel_index, bbox_x, bbox_y, bbox_w, bbox_h, yolo_class, pet_class, pet_id_override, confidence, detected_at
             FROM detections WHERE photo_id = ?1 ORDER BY panel_index",
        )?;
        let dets = stmt
            .query_map(params![photo_id], |row| {
                Ok(Detection {
                    id: row.get(0)?,
                    photo_id: row.get(1)?,
                    panel_index: row.get(2)?,
                    bbox_x: row.get(3)?,
                    bbox_y: row.get(4)?,
                    bbox_w: row.get(5)?,
                    bbox_h: row.get(6)?,
                    yolo_class: row.get(7)?,
                    pet_class: row.get(8)?,
                    pet_id_override: row.get(9)?,
                    confidence: row.get(10)?,
                    detected_at: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(dets)
    }

    pub fn update_detection_override(&self, detection_id: i64, pet_id: &str) -> rusqlite::Result<usize> {
        let updated = self.conn.execute(
            "UPDATE detections SET pet_id_override = ?1 WHERE id = ?2",
            params![pet_id, detection_id],
        )?;
        if updated > 0 {
            // Update photo's pet_id by majority vote of cat detections
            let photo_id: Option<i64> = self.conn.query_row(
                "SELECT photo_id FROM detections WHERE id = ?1",
                params![detection_id],
                |row| row.get(0),
            ).optional()?;
            if let Some(pid) = photo_id {
                self.update_pet_id_by_majority(pid)?;
            }
        }
        Ok(updated)
    }

    /// Update photo's pet_id based on majority vote of cat detection overrides/classes.
    fn update_pet_id_by_majority(&self, photo_id: i64) -> rusqlite::Result<()> {
        // For each cat detection, use pet_id_override if set, else pet_class
        let winner: Option<String> = self.conn.query_row(
            "SELECT COALESCE(pet_id_override, pet_class) AS effective_pet
             FROM detections
             WHERE photo_id = ?1 AND yolo_class = 'cat' AND COALESCE(pet_id_override, pet_class) IS NOT NULL
             GROUP BY effective_pet
             ORDER BY COUNT(*) DESC
             LIMIT 1",
            params![photo_id],
            |row| row.get(0),
        ).optional()?;
        if let Some(pet_id) = winner {
            self.conn.execute(
                "UPDATE photos SET pet_id = ?1 WHERE id = ?2",
                params![pet_id, photo_id],
            )?;
        }
        Ok(())
    }

    pub fn get_vlm_attempts(&self, filename: &str) -> rusqlite::Result<Option<i32>> {
        self.conn
            .query_row(
                "SELECT vlm_attempts FROM photos WHERE filename = ?1",
                params![filename],
                |row| row.get(0),
            )
            .optional()
    }

    /// Return filenames that need VLM processing (is_valid IS NULL, attempts < max).
    pub fn list_pending_filenames(&self, max_attempts: i32) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT filename FROM photos WHERE is_valid IS NULL AND vlm_attempts < ?1 ORDER BY captured_at ASC",
        )?;
        let names = stmt
            .query_map(params![max_attempts], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(names)
    }

    pub fn get_by_filename(&self, filename: &str) -> rusqlite::Result<Option<Photo>> {
        self.conn
            .query_row(
                "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior
                 FROM photos WHERE filename = ?1",
                params![filename],
                row_to_photo,
            )
            .optional()
    }

    pub fn get_by_id(&self, id: i64) -> rusqlite::Result<Option<Photo>> {
        self.conn
            .query_row(
                "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior
                 FROM photos WHERE id = ?1",
                params![id],
                row_to_photo,
            )
            .optional()
    }

    pub fn list(&self, filter: &PhotoFilter) -> rusqlite::Result<(Vec<Photo>, i64)> {
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if filter.is_pending {
            where_clauses.push("is_valid IS NULL");
        } else if let Some(valid) = filter.is_valid {
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
            .query_map(all_ref.as_slice(), row_to_photo)?
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

    #[test]
    fn record_vlm_failure_and_list_pending() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None).unwrap();

        // Both pending, 0 attempts
        let pending = store.list_pending_filenames(5).unwrap();
        assert_eq!(pending.len(), 2);

        // Record failure for a.jpg
        store.record_vlm_failure("a.jpg", "timeout").unwrap();
        let pending = store.list_pending_filenames(5).unwrap();
        assert_eq!(pending.len(), 2); // still under max

        // Exhaust retries for a.jpg
        for _ in 0..4 {
            store.record_vlm_failure("a.jpg", "timeout").unwrap();
        }
        let pending = store.list_pending_filenames(5).unwrap();
        assert_eq!(pending.len(), 1); // a.jpg excluded (5 attempts >= max)
        assert_eq!(pending[0], "b.jpg");
    }

    #[test]
    fn vlm_success_resets_error() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        store.record_vlm_failure("a.jpg", "timeout").unwrap();
        store.update_vlm_result("a.jpg", true, "cat", "resting").unwrap();

        let photo = store.get_by_filename("a.jpg").unwrap().unwrap();
        assert_eq!(photo.is_valid, Some(true));
        // Not in pending anymore
        let pending = store.list_pending_filenames(5).unwrap();
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn list_pending_filter() {
        let store = setup();
        store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None).unwrap();
        store.update_vlm_result("b.jpg", true, "cap", "resting").unwrap();

        let (photos, total) = store.list(&PhotoFilter { is_pending: true, ..Default::default() }).unwrap();
        assert_eq!(total, 1);
        assert_eq!(photos[0].filename, "a.jpg");
    }

    #[test]
    fn detection_override_updates_photo_pet_id_by_majority() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 0, 0);
        let detections = vec![
            DetectionInput {
                panel_index: Some(0),
                bbox_x: 10, bbox_y: 20, bbox_w: 100, bbox_h: 150,
                yolo_class: Some("cat".into()),
                pet_class: Some("chatora".into()),
                confidence: Some(0.9),
                detected_at: "2026-03-21T10:00:00".into(),
            },
            DetectionInput {
                panel_index: Some(1),
                bbox_x: 430, bbox_y: 20, bbox_w: 100, bbox_h: 150,
                yolo_class: Some("cat".into()),
                pet_class: Some("chatora".into()),
                confidence: Some(0.8),
                detected_at: "2026-03-21T10:00:00".into(),
            },
            DetectionInput {
                panel_index: Some(0),
                bbox_x: 300, bbox_y: 100, bbox_w: 80, bbox_h: 60,
                yolo_class: Some("cup".into()),
                pet_class: None,
                confidence: Some(0.6),
                detected_at: "2026-03-21T10:00:00".into(),
            },
        ];
        store.ingest_with_detections("test.jpg", ts, Some("chatora"), &detections).unwrap();

        // Initially pet_id is chatora
        let photo = store.get_by_filename("test.jpg").unwrap().unwrap();
        assert_eq!(photo.pet_id.as_deref(), Some("chatora"));

        // Override first cat detection to mike
        store.update_detection_override(1, "mike").unwrap();
        let photo = store.get_by_filename("test.jpg").unwrap().unwrap();
        // 1 mike + 1 chatora → tie, first wins (mike by query order)
        // but both have count=1, so ORDER BY COUNT(*) DESC LIMIT 1 picks one

        // Override second cat detection to mike too → majority is mike
        store.update_detection_override(2, "mike").unwrap();
        let photo = store.get_by_filename("test.jpg").unwrap().unwrap();
        assert_eq!(photo.pet_id.as_deref(), Some("mike"));

        // cup detection override should not affect majority (yolo_class != cat)
        // (cup detection id=3 is not a cat, so it's excluded from majority)
    }
}
