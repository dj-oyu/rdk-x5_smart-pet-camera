use crate::db::PhotoStore;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TrainingFrame {
    pub id: i64,
    pub filename: String,
    pub width: i32,
    pub height: i32,
    pub captured_at: Option<String>,
    /// pending / approved / rejected
    pub status: String,
    pub source: String,
    pub annotation_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrainingAnnotation {
    pub id: i64,
    pub frame_id: i64,
    pub class_label: String,
    /// YOLO normalized coordinates (0.0 - 1.0)
    pub x_center: f64,
    pub y_center: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnnotationInput {
    pub class_label: String,
    pub x_center: f64,
    pub y_center: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrainingStats {
    pub total: i64,
    pub pending: i64,
    pub approved: i64,
    pub rejected: i64,
    pub total_annotations: i64,
    pub class_counts: Vec<ClassCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassCount {
    pub class_label: String,
    pub count: i64,
}

/// (filename, width, height, annotations)
pub type ExportEntry = (String, i32, i32, Vec<TrainingAnnotation>);

// ── Migration ────────────────────────────────────────────────────

impl PhotoStore {
    pub fn migrate_training(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS training_frames (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                filename    TEXT    NOT NULL UNIQUE,
                width       INTEGER NOT NULL,
                height      INTEGER NOT NULL,
                captured_at TEXT,
                status      TEXT    NOT NULL DEFAULT 'pending',
                source      TEXT    NOT NULL DEFAULT 'rdk-x5',
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_training_frames_status
                ON training_frames(status);

            CREATE TABLE IF NOT EXISTS training_annotations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                frame_id    INTEGER NOT NULL REFERENCES training_frames(id) ON DELETE CASCADE,
                class_label TEXT    NOT NULL,
                x_center    REAL    NOT NULL,
                y_center    REAL    NOT NULL,
                width       REAL    NOT NULL,
                height      REAL    NOT NULL,
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_training_annotations_frame
                ON training_annotations(frame_id);",
        )?;
        Ok(())
    }

    // ── Frame CRUD ───────────────────────────────────────────────

    pub fn upsert_training_frame(
        &self,
        filename: &str,
        width: i32,
        height: i32,
        captured_at: Option<&str>,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO training_frames (filename, width, height, captured_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(filename) DO UPDATE SET width=?2, height=?3, captured_at=?4",
            params![filename, width, height, captured_at],
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM training_frames WHERE filename = ?1",
            params![filename],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    pub fn list_training_frames(
        &self,
        status: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> rusqlite::Result<(Vec<TrainingFrame>, i64)> {
        let where_clause = if status.is_some() {
            "WHERE f.status = ?1"
        } else {
            ""
        };

        // Count
        let total: i64 = if let Some(s) = status {
            self.conn.query_row(
                &format!("SELECT COUNT(*) FROM training_frames f {where_clause}"),
                params![s],
                |r| r.get(0),
            )?
        } else {
            self.conn
                .query_row("SELECT COUNT(*) FROM training_frames", [], |r| r.get(0))?
        };

        // List
        let sql = format!(
            "SELECT f.id, f.filename, f.width, f.height, f.captured_at, f.status,
                    f.source, f.created_at,
                    (SELECT COUNT(*) FROM training_annotations a WHERE a.frame_id = f.id)
             FROM training_frames f
             {where_clause}
             ORDER BY f.filename ASC
             LIMIT {limit} OFFSET {offset}"
        );

        let map_row = |r: &rusqlite::Row| {
            Ok(TrainingFrame {
                id: r.get(0)?,
                filename: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                captured_at: r.get(4)?,
                status: r.get(5)?,
                source: r.get(6)?,
                created_at: r.get(7)?,
                annotation_count: r.get(8)?,
            })
        };

        let frames = if let Some(s) = status {
            let mut stmt = self.conn.prepare(&sql)?;
            stmt.query_map(params![s], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = self.conn.prepare(&sql)?;
            stmt.query_map([], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        };

        Ok((frames, total))
    }

    pub fn get_training_frame(&self, id: i64) -> rusqlite::Result<Option<TrainingFrame>> {
        self.conn
            .query_row(
                "SELECT f.id, f.filename, f.width, f.height, f.captured_at, f.status,
                        f.source, f.created_at,
                        (SELECT COUNT(*) FROM training_annotations a WHERE a.frame_id = f.id)
                 FROM training_frames f WHERE f.id = ?1",
                params![id],
                |r| {
                    Ok(TrainingFrame {
                        id: r.get(0)?,
                        filename: r.get(1)?,
                        width: r.get(2)?,
                        height: r.get(3)?,
                        captured_at: r.get(4)?,
                        status: r.get(5)?,
                        source: r.get(6)?,
                        created_at: r.get(7)?,
                        annotation_count: r.get(8)?,
                    })
                },
            )
            .optional()
    }

    pub fn update_training_frame_status(&self, id: i64, status: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE training_frames SET status = ?1 WHERE id = ?2",
            params![status, id],
        )
    }

    // ── Annotation CRUD ──────────────────────────────────────────

    pub fn insert_training_annotation(
        &self,
        frame_id: i64,
        input: &AnnotationInput,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO training_annotations (frame_id, class_label, x_center, y_center, width, height)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                frame_id,
                input.class_label,
                input.x_center,
                input.y_center,
                input.width,
                input.height,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_training_annotations(
        &self,
        frame_id: i64,
    ) -> rusqlite::Result<Vec<TrainingAnnotation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, frame_id, class_label, x_center, y_center, width, height, created_at
             FROM training_annotations WHERE frame_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![frame_id], |r| {
            Ok(TrainingAnnotation {
                id: r.get(0)?,
                frame_id: r.get(1)?,
                class_label: r.get(2)?,
                x_center: r.get(3)?,
                y_center: r.get(4)?,
                width: r.get(5)?,
                height: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_training_annotation(&self, id: i64) -> rusqlite::Result<usize> {
        self.conn.execute(
            "DELETE FROM training_annotations WHERE id = ?1",
            params![id],
        )
    }

    pub fn replace_training_annotations(
        &self,
        frame_id: i64,
        annotations: &[AnnotationInput],
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM training_annotations WHERE frame_id = ?1",
            params![frame_id],
        )?;
        for ann in annotations {
            self.insert_training_annotation(frame_id, ann)?;
        }
        Ok(())
    }

    // ── Stats ────────────────────────────────────────────────────

    pub fn training_stats(&self) -> rusqlite::Result<TrainingStats> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM training_frames", [], |r| r.get(0))?;
        let pending: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM training_frames WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )?;
        let approved: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM training_frames WHERE status = 'approved'",
            [],
            |r| r.get(0),
        )?;
        let rejected: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM training_frames WHERE status = 'rejected'",
            [],
            |r| r.get(0),
        )?;
        let total_annotations: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM training_annotations", [], |r| {
                    r.get(0)
                })?;

        let mut stmt = self.conn.prepare(
            "SELECT class_label, COUNT(*) as cnt FROM training_annotations GROUP BY class_label ORDER BY cnt DESC",
        )?;
        let class_counts = stmt
            .query_map([], |r| {
                Ok(ClassCount {
                    class_label: r.get(0)?,
                    count: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(TrainingStats {
            total,
            pending,
            approved,
            rejected,
            total_annotations,
            class_counts,
        })
    }

    // ── Export (YOLO format) ─────────────────────────────────────

    /// Returns (filename, width, height, annotations) for approved frames.
    pub fn export_training_dataset(&self) -> rusqlite::Result<Vec<ExportEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, filename, width, height FROM training_frames WHERE status = 'approved' ORDER BY filename",
        )?;
        let frames: Vec<(i64, String, i32, i32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;

        let mut result = Vec::with_capacity(frames.len());
        for (id, filename, w, h) in frames {
            let anns = self.list_training_annotations(id)?;
            result.push((filename, w, h, anns));
        }
        Ok(result)
    }
}
