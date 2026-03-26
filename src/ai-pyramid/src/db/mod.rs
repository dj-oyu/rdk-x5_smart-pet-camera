use chrono::NaiveDateTime;
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Clone)]
pub struct Photo {
    pub id: i64,
    pub filename: String,
    pub captured_at: NaiveDateTime,
    pub caption: Option<String>,
    pub is_valid: Option<bool>,
    pub pet_id: Option<String>,
    pub behavior: Option<String>,
    pub detected_at: Option<String>,
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
    /// Opaque JSON from pet camera: UV scatter metrics, thresholds, version.
    /// ai-pyramid stores/returns this without parsing.
    pub color_metrics: Option<String>,
    /// 1=RDK X5 realtime, 2=AI Pyramid high-precision
    pub det_level: i32,
    /// Model identifier
    pub model: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EditHistoryEntry {
    pub id: i64,
    pub photo_id: i64,
    /// JSON diff of changes (opaque to ai-pyramid)
    pub changes: String,
    pub created_at: String,
}

/// Lightweight bbox for card grid sparkle overlay (no class/confidence).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BboxSummary {
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
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
    /// Opaque JSON blob from pet camera (color classification metrics).
    pub color_metrics: Option<serde_json::Value>,
    /// 1=RDK X5 realtime, 2=AI Pyramid high-precision
    #[serde(default = "default_det_level")]
    pub det_level: i32,
    /// Model identifier (e.g. "yolo26n-bpu", "yolo11s-ax650")
    #[serde(default)]
    pub model: Option<String>,
}

fn default_det_level() -> i32 {
    1
}

#[derive(Debug, Default)]
pub struct PhotoFilter {
    pub is_valid: Option<bool>,
    pub is_pending: bool,
    pub pet_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub behavior: Option<String>,
    pub yolo_classes: Vec<String>,
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
                detected_at     TEXT NOT NULL,
                color_metrics   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_detections_photo
                ON detections(photo_id);",
        )?;

        // Migration for existing DBs without color_metrics column
        let _ = self
            .conn
            .execute_batch("ALTER TABLE detections ADD COLUMN color_metrics TEXT;");

        // Migration: track when detection was run on a photo
        let _ = self
            .conn
            .execute_batch("ALTER TABLE photos ADD COLUMN detected_at TEXT;");

        // Migration: detection level and model tracking
        let _ = self.conn.execute_batch(
            "ALTER TABLE detections ADD COLUMN det_level INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE detections ADD COLUMN model TEXT;",
        );

        // Migration: caption quality level (0=basic VLM, 1=detection-enhanced VLM)
        let _ = self.conn.execute_batch(
            "ALTER TABLE photos ADD COLUMN caption_level INTEGER NOT NULL DEFAULT 0;",
        );

        // Edit history: records every user correction as a JSON diff
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS edit_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id   INTEGER NOT NULL REFERENCES photos(id),
                changes    TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_edit_history_photo
                ON edit_history(photo_id);
            CREATE INDEX IF NOT EXISTS idx_edit_history_created
                ON edit_history(created_at);",
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

    pub fn set_validation_override(
        &self,
        filename: &str,
        is_valid: bool,
    ) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE photos SET is_valid = ?1 WHERE filename = ?2",
            params![is_valid, filename],
        )
    }

    pub fn update_pet_id(&self, filename: &str, pet_id: &str) -> rusqlite::Result<usize> {
        if let Some((photo_id, old_value)) = self
            .conn
            .query_row(
                "SELECT id, pet_id FROM photos WHERE filename = ?1",
                params![filename],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
        {
            let changes = serde_json::json!({"pet_id": {"old": old_value, "new": pet_id}});
            self.conn.execute(
                "INSERT INTO edit_history (photo_id, changes) VALUES (?1, ?2)",
                params![photo_id, changes.to_string()],
            )?;
        }
        self.conn.execute(
            "UPDATE photos SET pet_id = ?1 WHERE filename = ?2",
            params![pet_id, filename],
        )
    }

    pub fn update_behavior(&self, filename: &str, behavior: &str) -> rusqlite::Result<usize> {
        if let Some((photo_id, old_value)) = self
            .conn
            .query_row(
                "SELECT id, behavior FROM photos WHERE filename = ?1",
                params![filename],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
        {
            let changes = serde_json::json!({"behavior": {"old": old_value, "new": behavior}});
            self.conn.execute(
                "INSERT INTO edit_history (photo_id, changes) VALUES (?1, ?2)",
                params![photo_id, changes.to_string()],
            )?;
        }
        self.conn.execute(
            "UPDATE photos SET behavior = ?1 WHERE filename = ?2",
            params![behavior, filename],
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

        // Mark as detected
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        self.conn.execute(
            "UPDATE photos SET detected_at = COALESCE(detected_at, ?1) WHERE id = ?2",
            params![now, photo_id],
        )?;

        // Build pet_class lookup from existing Level 1 cat detections (per panel)
        // so Level 2 detections can inherit pet identity
        let mut l1_pet: std::collections::HashMap<Option<i32>, String> =
            std::collections::HashMap::new();
        {
            let mut q = self.conn.prepare_cached(
                "SELECT panel_index, COALESCE(pet_id_override, pet_class) \
                 FROM detections \
                 WHERE photo_id = ?1 AND yolo_class = 'cat' AND det_level = 1 \
                   AND COALESCE(pet_id_override, pet_class) IS NOT NULL",
            )?;
            let rows = q.query_map(params![photo_id], |row| {
                Ok((row.get::<_, Option<i32>>(0)?, row.get::<_, String>(1)?))
            })?;
            for (panel, pet) in rows.flatten() {
                l1_pet.entry(panel).or_insert(pet);
            }
        }

        // Insert detections
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO detections (photo_id, panel_index, bbox_x, bbox_y, bbox_w, bbox_h, yolo_class, pet_class, confidence, detected_at, color_metrics, det_level, model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for d in detections {
            let metrics_str = d.color_metrics.as_ref().map(|v| v.to_string());
            // Inherit pet_class from Level 1 for cat detections without pet info
            let pet_class = if d.pet_class.is_some() {
                d.pet_class.clone()
            } else if d.yolo_class.as_deref() == Some("cat") {
                l1_pet.get(&d.panel_index).cloned()
            } else {
                None
            };
            stmt.execute(params![
                photo_id,
                d.panel_index,
                d.bbox_x,
                d.bbox_y,
                d.bbox_w,
                d.bbox_h,
                d.yolo_class,
                pet_class,
                d.confidence,
                d.detected_at,
                metrics_str,
                d.det_level,
                d.model,
            ])?;
        }

        Ok(photo_id)
    }

    /// Return detections for a photo, preferring highest det_level available.
    pub fn get_detections(&self, photo_id: i64) -> rusqlite::Result<Vec<Detection>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, photo_id, panel_index, bbox_x, bbox_y, bbox_w, bbox_h, yolo_class, pet_class, pet_id_override, confidence, detected_at, color_metrics, det_level, model
             FROM detections
             WHERE photo_id = ?1
               AND det_level = (SELECT COALESCE(MAX(det_level), 1) FROM detections WHERE photo_id = ?1)
             ORDER BY panel_index",
        )?;
        let dets = stmt
            .query_map(params![photo_id], Self::map_detection_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(dets)
    }

    fn map_detection_row(row: &rusqlite::Row) -> rusqlite::Result<Detection> {
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
            color_metrics: row.get(12)?,
            det_level: row.get(13)?,
            model: row.get(14)?,
        })
    }

    /// Return bboxes grouped by photo_id for a batch of photo IDs (single query).
    pub fn get_bboxes_for_photos(
        &self,
        photo_ids: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, Vec<BboxSummary>>> {
        use std::collections::HashMap;
        if photo_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders: String = photo_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT d.photo_id, d.bbox_x, d.bbox_y, d.bbox_w, d.bbox_h \
             FROM detections d \
             WHERE d.photo_id IN ({placeholders}) \
               AND d.det_level = ( \
                   SELECT COALESCE(MAX(d2.det_level), 1) \
                   FROM detections d2 WHERE d2.photo_id = d.photo_id \
               ) \
             ORDER BY d.photo_id"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let params: Vec<Box<dyn rusqlite::types::ToSql>> = photo_ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut map: HashMap<i64, Vec<BboxSummary>> = HashMap::new();
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                BboxSummary {
                    bbox_x: row.get(1)?,
                    bbox_y: row.get(2)?,
                    bbox_w: row.get(3)?,
                    bbox_h: row.get(4)?,
                },
            ))
        })?;
        for r in rows {
            let (pid, bbox) = r?;
            map.entry(pid).or_default().push(bbox);
        }
        Ok(map)
    }

    pub fn update_detection_override(
        &self,
        detection_id: i64,
        pet_id: &str,
    ) -> rusqlite::Result<usize> {
        // Read current value before update for edit_history
        let old: Option<(i64, Option<String>)> = self
            .conn
            .query_row(
                "SELECT photo_id, pet_id_override FROM detections WHERE id = ?1",
                params![detection_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let updated = self.conn.execute(
            "UPDATE detections SET pet_id_override = ?1 WHERE id = ?2",
            params![pet_id, detection_id],
        )?;
        if updated > 0
            && let Some((photo_id, old_value)) = old
        {
            // Record edit history
            let changes = serde_json::json!({
                "pet_id": { "old": old_value, "new": pet_id },
                "detection_id": detection_id,
            });
            self.conn.execute(
                "INSERT INTO edit_history (photo_id, changes) VALUES (?1, ?2)",
                params![photo_id, changes.to_string()],
            )?;

            // Update photo's pet_id by majority vote of cat detections
            self.update_pet_id_by_majority(photo_id)?;
        }
        Ok(updated)
    }

    pub fn get_edit_history(&self, since: Option<&str>) -> rusqlite::Result<Vec<EditHistoryEntry>> {
        let (sql, param): (&str, Option<&str>) = match since {
            Some(s) => (
                "SELECT id, photo_id, changes, created_at FROM edit_history WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 1000",
                Some(s),
            ),
            None => (
                "SELECT id, photo_id, changes, created_at FROM edit_history ORDER BY created_at DESC LIMIT 1000",
                None,
            ),
        };
        let mut stmt = self.conn.prepare_cached(sql)?;
        let rows = if let Some(p) = param {
            stmt.query_map(params![p], Self::map_edit_history_row)?
        } else {
            stmt.query_map([], Self::map_edit_history_row)?
        };
        rows.collect()
    }

    fn map_edit_history_row(row: &rusqlite::Row) -> rusqlite::Result<EditHistoryEntry> {
        Ok(EditHistoryEntry {
            id: row.get(0)?,
            photo_id: row.get(1)?,
            changes: row.get(2)?,
            created_at: row.get(3)?,
        })
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
        let mut stmt = self.conn.prepare_cached(
            "SELECT filename FROM photos WHERE is_valid IS NULL AND vlm_attempts < ?1 ORDER BY captured_at ASC LIMIT 500",
        )?;
        let names = stmt
            .query_map(params![max_attempts], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(names)
    }

    pub fn get_by_filename(&self, filename: &str) -> rusqlite::Result<Option<Photo>> {
        self.conn
            .query_row(
                "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior, detected_at
                 FROM photos WHERE filename = ?1",
                params![filename],
                row_to_photo,
            )
            .optional()
    }

    pub fn get_by_id(&self, id: i64) -> rusqlite::Result<Option<Photo>> {
        self.conn
            .query_row(
                "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior, detected_at
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
            where_clauses.push("p.is_valid IS NULL".to_string());
        } else if let Some(valid) = filter.is_valid {
            where_clauses.push("p.is_valid = ?".to_string());
            param_values.push(Box::new(valid));
        }
        if let Some(ref pid) = filter.pet_id {
            where_clauses.push("p.pet_id = ?".to_string());
            param_values.push(Box::new(pid.clone()));
        }
        if let Some(ref search) = filter.search {
            where_clauses.push("p.caption LIKE '%' || ? || '%'".to_string());
            param_values.push(Box::new(search.clone()));
        }
        if let Some(ref beh) = filter.behavior {
            where_clauses.push("p.behavior = ?".to_string());
            param_values.push(Box::new(beh.clone()));
        }

        // yolo_class filter: JOIN detections and filter by class
        let use_join = !filter.yolo_classes.is_empty();
        if use_join {
            let placeholders: Vec<String> = filter
                .yolo_classes
                .iter()
                .map(|_| "?".to_string())
                .collect();
            where_clauses.push(format!("d.yolo_class IN ({})", placeholders.join(",")));
            for cls in &filter.yolo_classes {
                param_values.push(Box::new(cls.clone()));
            }
        }

        let from_sql = if use_join {
            "photos p JOIN detections d ON d.photo_id = p.id"
        } else {
            "photos p"
        };

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // Count (DISTINCT when joining)
        let count_sql = if use_join {
            format!("SELECT COUNT(DISTINCT p.id) FROM {from_sql} {where_sql}")
        } else {
            format!("SELECT COUNT(*) FROM {from_sql} {where_sql}")
        };
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let total: i64 = self
            .conn
            .query_row(&count_sql, params_ref.as_slice(), |r| r.get(0))?;

        // Query
        let limit = filter.limit.unwrap_or(50);
        let offset = filter.offset.unwrap_or(0);
        let select_cols = "p.id, p.filename, p.captured_at, p.caption, p.is_valid, p.pet_id, p.behavior, p.detected_at";
        let query_sql = if use_join {
            format!(
                "SELECT DISTINCT {select_cols}
                 FROM {from_sql} {where_sql} ORDER BY p.captured_at DESC LIMIT ? OFFSET ?"
            )
        } else {
            format!(
                "SELECT {select_cols}
                 FROM {from_sql} {where_sql} ORDER BY p.captured_at DESC LIMIT ? OFFSET ?"
            )
        };
        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = param_values;
        all_params.push(Box::new(limit));
        all_params.push(Box::new(offset));
        let all_ref: Vec<&dyn rusqlite::types::ToSql> =
            all_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = self.conn.prepare_cached(&query_sql)?;
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

    pub fn distinct_pet_ids(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT DISTINCT pet_id FROM photos WHERE pet_id IS NOT NULL AND pet_id != '' ORDER BY pet_id LIMIT 100",
        )?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    pub fn distinct_behaviors(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT DISTINCT behavior FROM photos WHERE behavior IS NOT NULL AND behavior != '' ORDER BY behavior LIMIT 100",
        )?;
        let behaviors = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(behaviors)
    }

    /// Return captions for valid photos on a given date (YYYY-MM-DD).
    pub fn captions_for_date(&self, date: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT caption FROM photos WHERE is_valid = 1 AND caption IS NOT NULL AND captured_at LIKE ? || '%' ORDER BY captured_at ASC LIMIT 200",
        )?;
        let captions = stmt
            .query_map(params![date], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(captions)
    }

    /// Mark a photo as having had detection run, even if zero detections found.
    pub fn mark_detected(&self, photo_id: i64) -> rusqlite::Result<usize> {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        self.conn.execute(
            "UPDATE photos SET detected_at = ?1 WHERE id = ?2",
            params![now, photo_id],
        )
    }

    /// Return photos that have not yet been through detection.
    pub fn list_undetected_photos(&self, limit: i64) -> rusqlite::Result<Vec<Photo>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, filename, captured_at, caption, is_valid, pet_id, behavior, detected_at
             FROM photos
             WHERE detected_at IS NULL
             ORDER BY captured_at DESC
             LIMIT ?1",
        )?;
        let photos = stmt
            .query_map(params![limit], row_to_photo)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(photos)
    }

    pub fn stats(&self) -> rusqlite::Result<Stats> {
        self.conn.query_row(
            "SELECT COUNT(*) AS total,
                    COUNT(CASE WHEN is_valid = 1 THEN 1 END) AS valid,
                    COUNT(CASE WHEN is_valid = 0 THEN 1 END) AS invalid,
                    COUNT(CASE WHEN is_valid IS NULL THEN 1 END) AS pending
             FROM photos",
            [],
            |r| {
                Ok(Stats {
                    total: r.get(0)?,
                    valid: r.get(1)?,
                    invalid: r.get(2)?,
                    pending: r.get(3)?,
                })
            },
        )
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
    let captured_at =
        NaiveDateTime::parse_from_str(&captured_str, "%Y-%m-%dT%H:%M:%S").unwrap_or_default();
    let is_valid_int: Option<i32> = row.get(4)?;
    Ok(Photo {
        id: row.get(0)?,
        filename: row.get(1)?,
        captured_at,
        caption: row.get(3)?,
        is_valid: is_valid_int.map(|v| v != 0),
        pet_id: row.get(5)?,
        behavior: row.get(6)?,
        detected_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, s)
            .unwrap()
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
        store
            .insert("comic_20260321_104532_chatora.jpg", ts, Some("chatora"))
            .unwrap();

        let photo = store
            .get_by_filename("comic_20260321_104532_chatora.jpg")
            .unwrap()
            .unwrap();
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
        store
            .update_vlm_result("comic_test.jpg", true, "A tabby cat resting", "resting")
            .unwrap();

        let photo = store.get_by_filename("comic_test.jpg").unwrap().unwrap();
        assert_eq!(photo.is_valid, Some(true));
        assert_eq!(photo.caption.as_deref(), Some("A tabby cat resting"));
        assert_eq!(photo.behavior.as_deref(), Some("resting"));
    }

    #[test]
    fn list_with_filters() {
        let store = setup();
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora"))
            .unwrap();
        store
            .insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), Some("mike"))
            .unwrap();
        store
            .insert("c.jpg", dt(2026, 3, 21, 12, 0, 0), Some("chatora"))
            .unwrap();

        store
            .update_vlm_result("a.jpg", true, "cap a", "resting")
            .unwrap();
        store
            .update_vlm_result("b.jpg", false, "cap b", "other")
            .unwrap();
        store
            .update_vlm_result("c.jpg", true, "cap c", "eating")
            .unwrap();

        // All
        let (photos, total) = store.list(&PhotoFilter::default()).unwrap();
        assert_eq!(total, 3);
        assert_eq!(photos.len(), 3);
        assert_eq!(photos[0].filename, "c.jpg"); // newest first

        // Valid only
        let (photos, total) = store
            .list(&PhotoFilter {
                is_valid: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(photos.len(), 2);

        // By pet_id
        let (photos, total) = store
            .list(&PhotoFilter {
                pet_id: Some("chatora".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(photos[0].pet_id.as_deref(), Some("chatora"));

        // Pagination
        let (photos, total) = store
            .list(&PhotoFilter {
                limit: Some(1),
                offset: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0].filename, "b.jpg");
    }

    #[test]
    fn count_pending() {
        let store = setup();
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None)
            .unwrap();
        store
            .insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None)
            .unwrap();
        assert_eq!(store.count_pending().unwrap(), 2);

        store
            .update_vlm_result("a.jpg", true, "cap", "resting")
            .unwrap();
        assert_eq!(store.count_pending().unwrap(), 1);
    }

    #[test]
    fn stats_counts() {
        let store = setup();
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None)
            .unwrap();
        store
            .insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None)
            .unwrap();
        store
            .insert("c.jpg", dt(2026, 3, 21, 12, 0, 0), None)
            .unwrap();
        store
            .update_vlm_result("a.jpg", true, "cap", "resting")
            .unwrap();
        store
            .update_vlm_result("b.jpg", false, "cap", "other")
            .unwrap();

        let s = store.stats().unwrap();
        assert_eq!(s.total, 3);
        assert_eq!(s.valid, 1);
        assert_eq!(s.invalid, 1);
        assert_eq!(s.pending, 1);
    }

    #[test]
    fn record_vlm_failure_and_list_pending() {
        let store = setup();
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None)
            .unwrap();
        store
            .insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None)
            .unwrap();

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
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None)
            .unwrap();
        store.record_vlm_failure("a.jpg", "timeout").unwrap();
        store
            .update_vlm_result("a.jpg", true, "cat", "resting")
            .unwrap();

        let photo = store.get_by_filename("a.jpg").unwrap().unwrap();
        assert_eq!(photo.is_valid, Some(true));
        // Not in pending anymore
        let pending = store.list_pending_filenames(5).unwrap();
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn list_pending_filter() {
        let store = setup();
        store
            .insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None)
            .unwrap();
        store
            .insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), None)
            .unwrap();
        store
            .update_vlm_result("b.jpg", true, "cap", "resting")
            .unwrap();

        let (photos, total) = store
            .list(&PhotoFilter {
                is_pending: true,
                ..Default::default()
            })
            .unwrap();
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
                bbox_x: 10,
                bbox_y: 20,
                bbox_w: 100,
                bbox_h: 150,
                yolo_class: Some("cat".into()),
                pet_class: Some("chatora".into()),
                confidence: Some(0.9),
                detected_at: "2026-03-21T10:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
            DetectionInput {
                panel_index: Some(1),
                bbox_x: 430,
                bbox_y: 20,
                bbox_w: 100,
                bbox_h: 150,
                yolo_class: Some("cat".into()),
                pet_class: Some("chatora".into()),
                confidence: Some(0.8),
                detected_at: "2026-03-21T10:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
            DetectionInput {
                panel_index: Some(0),
                bbox_x: 300,
                bbox_y: 100,
                bbox_w: 80,
                bbox_h: 60,
                yolo_class: Some("cup".into()),
                pet_class: None,
                confidence: Some(0.6),
                detected_at: "2026-03-21T10:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
        ];
        store
            .ingest_with_detections("test.jpg", ts, Some("chatora"), &detections)
            .unwrap();

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

    #[test]
    fn list_undetected_photos_filters_correctly() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 45, 0);

        // Insert two photos
        store.insert("a.jpg", ts, Some("chatora")).unwrap();
        store.insert("b.jpg", ts, Some("mike")).unwrap();

        // Both should appear (detected_at is NULL)
        let result = store.list_undetected_photos(100).unwrap();
        assert_eq!(result.len(), 2);

        // Ingest detections for a.jpg → sets detected_at
        let detections = vec![DetectionInput {
            panel_index: None,
            bbox_x: 10,
            bbox_y: 10,
            bbox_w: 50,
            bbox_h: 50,
            yolo_class: Some("cat".into()),
            pet_class: None,
            confidence: Some(0.9),
            detected_at: "2026-03-21T10:45:00".into(),
            color_metrics: None,
            det_level: 1,
            model: None,
        }];
        store
            .ingest_with_detections("a.jpg", ts, Some("chatora"), &detections)
            .unwrap();

        // Only b.jpg should remain (a.jpg has detected_at set)
        let result = store.list_undetected_photos(100).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].filename, "b.jpg");

        // mark_detected on b.jpg (zero detections case)
        let photo_b = store.get_by_filename("b.jpg").unwrap().unwrap();
        store.mark_detected(photo_b.id).unwrap();

        // Now no undetected photos
        let result = store.list_undetected_photos(100).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_filters_by_yolo_class() {
        let store = setup();
        let ts = dt(2026, 3, 21, 10, 45, 0);

        store.insert("cat_only.jpg", ts, Some("chatora")).unwrap();
        store.insert("dog_only.jpg", ts, Some("mike")).unwrap();
        store.insert("no_det.jpg", ts, None).unwrap();

        let cat_det = vec![DetectionInput {
            panel_index: None,
            bbox_x: 10,
            bbox_y: 10,
            bbox_w: 50,
            bbox_h: 50,
            yolo_class: Some("cat".into()),
            pet_class: None,
            confidence: Some(0.9),
            detected_at: "2026-03-21T10:45:00".into(),
            color_metrics: None,
            det_level: 1,
            model: None,
        }];
        store
            .ingest_with_detections("cat_only.jpg", ts, Some("chatora"), &cat_det)
            .unwrap();

        let dog_det = vec![DetectionInput {
            panel_index: None,
            bbox_x: 10,
            bbox_y: 10,
            bbox_w: 50,
            bbox_h: 50,
            yolo_class: Some("dog".into()),
            pet_class: None,
            confidence: Some(0.8),
            detected_at: "2026-03-21T10:45:00".into(),
            color_metrics: None,
            det_level: 1,
            model: None,
        }];
        store
            .ingest_with_detections("dog_only.jpg", ts, Some("mike"), &dog_det)
            .unwrap();

        // Filter by cat
        let (photos, total) = store
            .list(&PhotoFilter {
                yolo_classes: vec!["cat".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(photos[0].filename, "cat_only.jpg");

        // Filter by cat + dog
        let (photos, total) = store
            .list(&PhotoFilter {
                yolo_classes: vec!["cat".into(), "dog".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 2);

        // No filter → all 3
        let (_, total) = store.list(&PhotoFilter::default()).unwrap();
        assert_eq!(total, 3);
    }

    #[test]
    fn bboxes_prefer_max_det_level() {
        let store = setup();
        let ts = dt(2026, 3, 21, 11, 0, 0);

        // Photo with L1 detections (3 bboxes)
        let l1_dets = vec![
            DetectionInput {
                panel_index: Some(0),
                bbox_x: 10,
                bbox_y: 20,
                bbox_w: 100,
                bbox_h: 80,
                yolo_class: Some("cat".into()),
                pet_class: None,
                confidence: Some(0.7),
                detected_at: "2026-03-21T11:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
            DetectionInput {
                panel_index: Some(1),
                bbox_x: 200,
                bbox_y: 30,
                bbox_w: 90,
                bbox_h: 70,
                yolo_class: Some("cat".into()),
                pet_class: None,
                confidence: Some(0.6),
                detected_at: "2026-03-21T11:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
            DetectionInput {
                panel_index: Some(2),
                bbox_x: 50,
                bbox_y: 250,
                bbox_w: 80,
                bbox_h: 60,
                yolo_class: Some("cup".into()),
                pet_class: None,
                confidence: Some(0.5),
                detected_at: "2026-03-21T11:00:00".into(),
                color_metrics: None,
                det_level: 1,
                model: None,
            },
        ];
        store
            .ingest_with_detections("mixed.jpg", ts, Some("chatora"), &l1_dets)
            .unwrap();

        // Add L2 detections (2 bboxes, different positions)
        let l2_dets = vec![
            DetectionInput {
                panel_index: Some(0),
                bbox_x: 15,
                bbox_y: 25,
                bbox_w: 95,
                bbox_h: 75,
                yolo_class: Some("cat".into()),
                pet_class: None,
                confidence: Some(0.9),
                detected_at: "2026-03-21T11:00:00".into(),
                color_metrics: None,
                det_level: 2,
                model: Some("yolo11s-ax650".into()),
            },
            DetectionInput {
                panel_index: Some(1),
                bbox_x: 205,
                bbox_y: 35,
                bbox_w: 85,
                bbox_h: 65,
                yolo_class: Some("cat".into()),
                pet_class: None,
                confidence: Some(0.85),
                detected_at: "2026-03-21T11:00:00".into(),
                color_metrics: None,
                det_level: 2,
                model: Some("yolo11s-ax650".into()),
            },
        ];
        store
            .ingest_with_detections("mixed.jpg", ts, Some("chatora"), &l2_dets)
            .unwrap();

        // Photo with L1 only
        let l1_only = vec![DetectionInput {
            panel_index: Some(0),
            bbox_x: 30,
            bbox_y: 40,
            bbox_w: 110,
            bbox_h: 90,
            yolo_class: Some("cat".into()),
            pet_class: None,
            confidence: Some(0.8),
            detected_at: "2026-03-21T11:00:00".into(),
            color_metrics: None,
            det_level: 1,
            model: None,
        }];
        store
            .ingest_with_detections("l1only.jpg", ts, Some("mike"), &l1_only)
            .unwrap();

        // get_bboxes_for_photos: mixed.jpg should return only L2 (2 bboxes)
        let mixed_id: i64 = store
            .conn
            .query_row(
                "SELECT id FROM photos WHERE filename='mixed.jpg'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let l1only_id: i64 = store
            .conn
            .query_row(
                "SELECT id FROM photos WHERE filename='l1only.jpg'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let map = store.get_bboxes_for_photos(&[mixed_id, l1only_id]).unwrap();

        // mixed.jpg: only L2 bboxes (2, not 5)
        let mixed_bboxes = map.get(&mixed_id).unwrap();
        assert_eq!(mixed_bboxes.len(), 2);
        assert_eq!(mixed_bboxes[0].bbox_x, 15); // L2 coordinate
        assert_eq!(mixed_bboxes[1].bbox_x, 205);

        // l1only.jpg: L1 bboxes (1)
        let l1_bboxes = map.get(&l1only_id).unwrap();
        assert_eq!(l1_bboxes.len(), 1);
        assert_eq!(l1_bboxes[0].bbox_x, 30);
    }
}
