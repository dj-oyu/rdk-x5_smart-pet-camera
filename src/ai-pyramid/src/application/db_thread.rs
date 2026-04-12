use crate::application::AppResult;
use crate::db::{
    BboxSummary, Detection, DetectionInput, EditHistoryEntry, Photo, PhotoFilter, PhotoStore, Stats,
};
use crate::training::db::{
    AnnotationInput, ExportEntry, TrainingAnnotation, TrainingFrame, TrainingStats,
};
use chrono::NaiveDateTime;
use std::sync::mpsc;
use std::thread;
use tokio::sync::oneshot;

#[derive(Clone)]
pub struct Database {
    tx: mpsc::Sender<DbCommand>,
}

impl Database {
    pub fn new(store: PhotoStore) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("photo-db".into())
            .spawn(move || run_database_loop(store, rx))
            .expect("failed to spawn photo-db thread");
        Self { tx }
    }

    pub async fn request<T, F>(&self, build: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(oneshot::Sender<AppResult<T>>) -> DbCommand,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| "database thread unavailable".to_string())?;
        reply_rx
            .await
            .map_err(|_| "database reply channel closed".to_string())?
    }
}

pub enum DbCommand {
    InsertPhoto {
        filename: String,
        captured_at: NaiveDateTime,
        pet_id: Option<String>,
        reply: oneshot::Sender<AppResult<i64>>,
    },
    GetPhoto {
        filename: String,
        reply: oneshot::Sender<AppResult<Option<Photo>>>,
    },
    GetPhotoById {
        id: i64,
        reply: oneshot::Sender<AppResult<Option<Photo>>>,
    },
    ListPhotos {
        filter: PhotoFilter,
        reply: oneshot::Sender<AppResult<(Vec<Photo>, i64)>>,
    },
    ListPendingFilenames {
        max_attempts: i32,
        reply: oneshot::Sender<AppResult<Vec<String>>>,
    },
    ApplyVlmResult {
        filename: String,
        is_valid: bool,
        caption: String,
        behavior: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    OverrideValidation {
        filename: String,
        is_valid: bool,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    RecordVlmFailure {
        filename: String,
        error: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    Stats {
        reply: oneshot::Sender<AppResult<Stats>>,
    },
    GetVlmAttempts {
        filename: String,
        reply: oneshot::Sender<AppResult<Option<i32>>>,
    },
    IngestWithDetections {
        filename: String,
        captured_at: NaiveDateTime,
        pet_id: Option<String>,
        detections: Vec<DetectionInput>,
        reply: oneshot::Sender<AppResult<i64>>,
    },
    GetDetections {
        photo_id: i64,
        reply: oneshot::Sender<AppResult<Vec<Detection>>>,
    },
    UpdateDetectionOverride {
        detection_id: i64,
        pet_id: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    UpdatePetId {
        filename: String,
        pet_id: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    UpdateBehavior {
        filename: String,
        behavior: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    DistinctPetIds {
        reply: oneshot::Sender<AppResult<Vec<String>>>,
    },
    DistinctBehaviors {
        reply: oneshot::Sender<AppResult<Vec<String>>>,
    },
    CaptionsForDate {
        date: String,
        reply: oneshot::Sender<AppResult<Vec<String>>>,
    },
    ListUndetectedPhotos {
        limit: i64,
        reply: oneshot::Sender<AppResult<Vec<Photo>>>,
    },
    MarkDetected {
        photo_id: i64,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    GetEditHistory {
        since: Option<String>,
        reply: oneshot::Sender<AppResult<Vec<EditHistoryEntry>>>,
    },
    GetBboxesForPhotos {
        photo_ids: Vec<i64>,
        reply: oneshot::Sender<AppResult<std::collections::HashMap<i64, Vec<BboxSummary>>>>,
    },
    // ── Training ─────────────────────────────────────────────
    TrainingUpsertFrame {
        filename: String,
        width: i32,
        height: i32,
        captured_at: Option<String>,
        reply: oneshot::Sender<AppResult<i64>>,
    },
    TrainingListFrames {
        status: Option<String>,
        limit: i64,
        offset: i64,
        reply: oneshot::Sender<AppResult<(Vec<TrainingFrame>, i64)>>,
    },
    TrainingGetFrame {
        id: i64,
        reply: oneshot::Sender<AppResult<Option<TrainingFrame>>>,
    },
    TrainingUpdateStatus {
        id: i64,
        status: String,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    TrainingListAnnotations {
        frame_id: i64,
        reply: oneshot::Sender<AppResult<Vec<TrainingAnnotation>>>,
    },
    TrainingReplaceAnnotations {
        frame_id: i64,
        annotations: Vec<AnnotationInput>,
        reply: oneshot::Sender<AppResult<()>>,
    },
    TrainingDeleteAnnotation {
        id: i64,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    TrainingDeleteRejected {
        reply: oneshot::Sender<AppResult<Vec<String>>>,
    },
    TrainingStats {
        reply: oneshot::Sender<AppResult<TrainingStats>>,
    },
    TrainingExport {
        reply: oneshot::Sender<AppResult<Vec<ExportEntry>>>,
    },
}

fn run_database_loop(store: PhotoStore, rx: mpsc::Receiver<DbCommand>) {
    for command in rx {
        match command {
            DbCommand::InsertPhoto {
                filename,
                captured_at,
                pet_id,
                reply,
            } => send_reply(
                reply,
                store.insert(&filename, captured_at, pet_id.as_deref()),
            ),
            DbCommand::GetPhoto { filename, reply } => {
                send_reply(reply, store.get_by_filename(&filename))
            }
            DbCommand::GetPhotoById { id, reply } => send_reply(reply, store.get_by_id(id)),
            DbCommand::ListPhotos { filter, reply } => send_reply(reply, store.list(&filter)),
            DbCommand::ListPendingFilenames {
                max_attempts,
                reply,
            } => send_reply(reply, store.list_pending_filenames(max_attempts)),
            DbCommand::ApplyVlmResult {
                filename,
                is_valid,
                caption,
                behavior,
                reply,
            } => send_reply(
                reply,
                store.update_vlm_result(&filename, is_valid, &caption, &behavior),
            ),
            DbCommand::OverrideValidation {
                filename,
                is_valid,
                reply,
            } => send_reply(reply, store.set_validation_override(&filename, is_valid)),
            DbCommand::RecordVlmFailure {
                filename,
                error,
                reply,
            } => send_reply(reply, store.record_vlm_failure(&filename, &error)),
            DbCommand::Stats { reply } => send_reply(reply, store.stats()),
            DbCommand::GetVlmAttempts { filename, reply } => {
                send_reply(reply, store.get_vlm_attempts(&filename))
            }
            DbCommand::IngestWithDetections {
                filename,
                captured_at,
                pet_id,
                detections,
                reply,
            } => send_reply(
                reply,
                store.ingest_with_detections(
                    &filename,
                    captured_at,
                    pet_id.as_deref(),
                    &detections,
                ),
            ),
            DbCommand::GetDetections { photo_id, reply } => {
                send_reply(reply, store.get_detections(photo_id))
            }
            DbCommand::UpdateDetectionOverride {
                detection_id,
                pet_id,
                reply,
            } => send_reply(
                reply,
                store.update_detection_override(detection_id, &pet_id),
            ),
            DbCommand::UpdatePetId {
                filename,
                pet_id,
                reply,
            } => send_reply(reply, store.update_pet_id(&filename, &pet_id)),
            DbCommand::UpdateBehavior {
                filename,
                behavior,
                reply,
            } => send_reply(reply, store.update_behavior(&filename, &behavior)),
            DbCommand::DistinctPetIds { reply } => send_reply(reply, store.distinct_pet_ids()),
            DbCommand::DistinctBehaviors { reply } => send_reply(reply, store.distinct_behaviors()),
            DbCommand::CaptionsForDate { date, reply } => {
                send_reply(reply, store.captions_for_date(&date))
            }
            DbCommand::ListUndetectedPhotos { limit, reply } => {
                send_reply(reply, store.list_undetected_photos(limit))
            }
            DbCommand::MarkDetected { photo_id, reply } => {
                send_reply(reply, store.mark_detected(photo_id))
            }
            DbCommand::GetEditHistory { since, reply } => {
                send_reply(reply, store.get_edit_history(since.as_deref()))
            }
            DbCommand::GetBboxesForPhotos { photo_ids, reply } => {
                send_reply(reply, store.get_bboxes_for_photos(&photo_ids))
            }
            // ── Training ─────────────────────────────────────────
            DbCommand::TrainingUpsertFrame {
                filename,
                width,
                height,
                captured_at,
                reply,
            } => send_reply(
                reply,
                store.upsert_training_frame(&filename, width, height, captured_at.as_deref()),
            ),
            DbCommand::TrainingListFrames {
                status,
                limit,
                offset,
                reply,
            } => send_reply(
                reply,
                store.list_training_frames(status.as_deref(), limit, offset),
            ),
            DbCommand::TrainingGetFrame { id, reply } => {
                send_reply(reply, store.get_training_frame(id))
            }
            DbCommand::TrainingUpdateStatus { id, status, reply } => {
                send_reply(reply, store.update_training_frame_status(id, &status))
            }
            DbCommand::TrainingListAnnotations { frame_id, reply } => {
                send_reply(reply, store.list_training_annotations(frame_id))
            }
            DbCommand::TrainingReplaceAnnotations {
                frame_id,
                annotations,
                reply,
            } => send_reply(
                reply,
                store.replace_training_annotations(frame_id, &annotations),
            ),
            DbCommand::TrainingDeleteAnnotation { id, reply } => {
                send_reply(reply, store.delete_training_annotation(id))
            }
            DbCommand::TrainingDeleteRejected { reply } => {
                send_reply(reply, store.delete_rejected_frames())
            }
            DbCommand::TrainingStats { reply } => send_reply(reply, store.training_stats()),
            DbCommand::TrainingExport { reply } => {
                send_reply(reply, store.export_training_dataset())
            }
        }
    }
}

fn send_reply<T>(reply: oneshot::Sender<AppResult<T>>, result: rusqlite::Result<T>) {
    let _ = reply.send(result.map_err(|e| e.to_string()));
}
