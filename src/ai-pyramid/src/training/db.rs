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
    /// Whether this frame is used as a background reference for scoring.
    pub is_bg_ref: bool,
    /// Background model score (% of outlier pixels). None = not yet scored.
    pub bg_score: Option<f64>,
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
        // Additive migrations — silently ignored if columns already exist.
        let _ = self.conn.execute_batch(
            "ALTER TABLE training_frames ADD COLUMN is_bg_ref INTEGER NOT NULL DEFAULT 0;
             CREATE INDEX IF NOT EXISTS idx_training_frames_bg_ref
                 ON training_frames(is_bg_ref);",
        );
        let _ = self
            .conn
            .execute_batch("ALTER TABLE training_frames ADD COLUMN bg_score REAL;");
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
                    (SELECT COUNT(*) FROM training_annotations a WHERE a.frame_id = f.id),
                    f.is_bg_ref, f.bg_score
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
                is_bg_ref: r.get::<_, i32>(9)? != 0,
                bg_score: r.get(10)?,
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
                        (SELECT COUNT(*) FROM training_annotations a WHERE a.frame_id = f.id),
                        f.is_bg_ref, f.bg_score
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
                        is_bg_ref: r.get::<_, i32>(9)? != 0,
                        bg_score: r.get(10)?,
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
        self.conn.execute_batch("BEGIN")?;
        let result = (|| -> rusqlite::Result<()> {
            self.conn.execute(
                "DELETE FROM training_annotations WHERE frame_id = ?1",
                params![frame_id],
            )?;
            for ann in annotations {
                self.insert_training_annotation(frame_id, ann)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT"),
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Delete all rejected frames in one transaction.
    /// Frames with `is_bg_ref = 1` are skipped — they must be de-referenced
    /// before cleanup can remove them.
    /// Returns the filenames of deleted frames (for cache + remote cleanup by the caller).
    /// Annotations are removed automatically via ON DELETE CASCADE.
    pub fn delete_rejected_frames(&self) -> rusqlite::Result<Vec<String>> {
        self.conn.execute_batch("BEGIN")?;
        let result = (|| -> rusqlite::Result<Vec<String>> {
            let mut stmt = self.conn.prepare(
                "SELECT filename FROM training_frames WHERE status = 'rejected' AND is_bg_ref = 0",
            )?;
            let filenames: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            self.conn.execute(
                "DELETE FROM training_frames WHERE status = 'rejected' AND is_bg_ref = 0",
                [],
            )?;
            Ok(filenames)
        })();
        match result {
            Ok(filenames) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(filenames)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // ── Background model ─────────────────────────────────────────────────

    pub fn set_bg_ref(&self, id: i64, is_bg_ref: bool) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE training_frames SET is_bg_ref = ?1 WHERE id = ?2",
            params![is_bg_ref as i32, id],
        )
    }

    /// Returns (id, filename) pairs for all frames marked as background references.
    pub fn list_bg_ref_frames(&self) -> rusqlite::Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, filename FROM training_frames WHERE is_bg_ref = 1 ORDER BY filename",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Count of bg_ref frames.
    pub fn bg_ref_count(&self) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM training_frames WHERE is_bg_ref = 1",
            [],
            |r| r.get(0),
        )
    }

    /// Bulk-update bg_score for a list of (id, score) pairs.
    pub fn bulk_update_bg_scores(&self, scores: &[(i64, f64)]) -> rusqlite::Result<usize> {
        if scores.is_empty() {
            return Ok(0);
        }
        self.conn.execute_batch("BEGIN")?;
        let result = (|| -> rusqlite::Result<usize> {
            let mut count = 0;
            for (id, score) in scores {
                count += self.conn.execute(
                    "UPDATE training_frames SET bg_score = ?1 WHERE id = ?2",
                    params![score, id],
                )?;
            }
            Ok(count)
        })();
        match result {
            Ok(n) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(n)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Set status = 'rejected' for all pending frames with bg_score <= threshold.
    /// Returns the number of frames rejected.
    pub fn bulk_reject_by_score(&self, threshold: f64) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE training_frames SET status = 'rejected'
             WHERE status = 'pending' AND bg_score IS NOT NULL AND bg_score <= ?1",
            params![threshold],
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PhotoStore {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate_training().unwrap();
        store
    }

    fn annotation(class_label: &str, x_center: f64) -> AnnotationInput {
        AnnotationInput {
            class_label: class_label.to_string(),
            x_center,
            y_center: 0.5,
            width: 0.25,
            height: 0.4,
        }
    }

    #[test]
    fn frame_upsert_preserves_identity_and_list_contract() {
        let store = store();
        let first_id = store
            .upsert_training_frame("frame-b.nv12", 1920, 1080, None)
            .unwrap();
        let second_id = store
            .upsert_training_frame(
                "frame-a.nv12",
                640,
                480,
                Some("2026-01-02T03:04:05"),
            )
            .unwrap();

        let updated_id = store
            .upsert_training_frame("frame-b.nv12", 1280, 720, Some("new-timestamp"))
            .unwrap();
        assert_eq!(updated_id, first_id);

        store
            .update_training_frame_status(second_id, "approved")
            .unwrap();
        let (all, total) = store.list_training_frames(None, 1, 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].filename, "frame-a.nv12");

        let (approved, approved_total) = store
            .list_training_frames(Some("approved"), 50, 0)
            .unwrap();
        assert_eq!(approved_total, 1);
        assert_eq!(approved[0].id, second_id);

        let updated = store.get_training_frame(first_id).unwrap().unwrap();
        assert_eq!((updated.width, updated.height), (1280, 720));
        assert_eq!(updated.captured_at.as_deref(), Some("new-timestamp"));
    }

    #[test]
    fn replacing_annotations_updates_frame_count_and_supports_delete() {
        let store = store();
        let frame_id = store
            .upsert_training_frame("annotated.nv12", 640, 480, None)
            .unwrap();
        store
            .replace_training_annotations(
                frame_id,
                &[annotation("dog", 0.25), annotation("cat", 0.75)],
            )
            .unwrap();

        let frame = store.get_training_frame(frame_id).unwrap().unwrap();
        assert_eq!(frame.annotation_count, 2);
        let original = store.list_training_annotations(frame_id).unwrap();
        assert_eq!(
            original
                .iter()
                .map(|a| a.class_label.as_str())
                .collect::<Vec<_>>(),
            vec!["dog", "cat"]
        );

        store
            .replace_training_annotations(frame_id, &[annotation("bird", 0.5)])
            .unwrap();
        let replacement = store.list_training_annotations(frame_id).unwrap();
        assert_eq!(replacement.len(), 1);
        assert_eq!(replacement[0].class_label, "bird");
        assert_eq!(store.delete_training_annotation(replacement[0].id).unwrap(), 1);
        assert!(store
            .list_training_annotations(frame_id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stats_and_export_include_only_approved_frames() {
        let store = store();
        let approved = store
            .upsert_training_frame("approved.nv12", 640, 480, None)
            .unwrap();
        let rejected = store
            .upsert_training_frame("rejected.nv12", 320, 240, None)
            .unwrap();
        store
            .update_training_frame_status(approved, "approved")
            .unwrap();
        store
            .update_training_frame_status(rejected, "rejected")
            .unwrap();
        store
            .replace_training_annotations(
                approved,
                &[annotation("cat", 0.4), annotation("cat", 0.6)],
            )
            .unwrap();
        store
            .replace_training_annotations(rejected, &[annotation("dog", 0.5)])
            .unwrap();

        let stats = store.training_stats().unwrap();
        assert_eq!(
            (stats.total, stats.pending, stats.approved, stats.rejected),
            (2, 0, 1, 1)
        );
        assert_eq!(stats.total_annotations, 3);
        assert_eq!(stats.class_counts[0].class_label, "cat");
        assert_eq!(stats.class_counts[0].count, 2);

        let export = store.export_training_dataset().unwrap();
        assert_eq!(export.len(), 1);
        assert_eq!(export[0].0, "approved.nv12");
        assert_eq!(export[0].3.len(), 2);
    }

    #[test]
    fn background_scores_reject_only_eligible_pending_frames() {
        let store = store();
        let low = store
            .upsert_training_frame("low.nv12", 640, 480, None)
            .unwrap();
        let high = store
            .upsert_training_frame("high.nv12", 640, 480, None)
            .unwrap();
        let approved = store
            .upsert_training_frame("approved.nv12", 640, 480, None)
            .unwrap();
        store
            .update_training_frame_status(approved, "approved")
            .unwrap();
        assert_eq!(
            store
                .bulk_update_bg_scores(&[(low, 2.0), (high, 9.0), (approved, 1.0)])
                .unwrap(),
            3
        );
        assert_eq!(store.bulk_reject_by_score(5.0).unwrap(), 1);
        assert_eq!(
            store.get_training_frame(low).unwrap().unwrap().status,
            "rejected"
        );
        assert_eq!(
            store.get_training_frame(high).unwrap().unwrap().status,
            "pending"
        );
        assert_eq!(
            store.get_training_frame(approved).unwrap().unwrap().status,
            "approved"
        );
    }

    #[test]
    fn rejected_cleanup_preserves_background_references() {
        let store = store();
        let removable = store
            .upsert_training_frame("remove.nv12", 640, 480, None)
            .unwrap();
        let bg_ref = store
            .upsert_training_frame("keep.nv12", 640, 480, None)
            .unwrap();
        store
            .update_training_frame_status(removable, "rejected")
            .unwrap();
        store
            .update_training_frame_status(bg_ref, "rejected")
            .unwrap();
        store.set_bg_ref(bg_ref, true).unwrap();

        assert_eq!(store.bg_ref_count().unwrap(), 1);
        assert_eq!(
            store.list_bg_ref_frames().unwrap(),
            vec![(bg_ref, "keep.nv12".to_string())]
        );
        assert_eq!(
            store.delete_rejected_frames().unwrap(),
            vec!["remove.nv12".to_string()]
        );
        assert!(store.get_training_frame(removable).unwrap().is_none());
        assert!(store.get_training_frame(bg_ref).unwrap().is_some());
    }
}
