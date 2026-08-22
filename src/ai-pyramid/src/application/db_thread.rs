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

mod album;
mod training;

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
    RecordEmptyLevel2 {
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
    // ── Background model ─────────────────────────────────────
    TrainingSetBgRef {
        id: i64,
        is_bg_ref: bool,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    TrainingListBgRefFrames {
        reply: oneshot::Sender<AppResult<Vec<(i64, String)>>>,
    },
    TrainingBgRefCount {
        reply: oneshot::Sender<AppResult<i64>>,
    },
    TrainingBulkUpdateBgScores {
        scores: Vec<(i64, f64)>,
        reply: oneshot::Sender<AppResult<usize>>,
    },
    TrainingBulkRejectByScore {
        threshold: f64,
        reply: oneshot::Sender<AppResult<usize>>,
    },
}

enum CommandDomain {
    Album(DbCommand),
    Training(DbCommand),
}

impl DbCommand {
    fn into_domain(self) -> CommandDomain {
        match self {
            command @ (DbCommand::InsertPhoto { .. }
            | DbCommand::GetPhoto { .. }
            | DbCommand::GetPhotoById { .. }
            | DbCommand::ListPhotos { .. }
            | DbCommand::ListPendingFilenames { .. }
            | DbCommand::ApplyVlmResult { .. }
            | DbCommand::OverrideValidation { .. }
            | DbCommand::RecordVlmFailure { .. }
            | DbCommand::Stats { .. }
            | DbCommand::GetVlmAttempts { .. }
            | DbCommand::IngestWithDetections { .. }
            | DbCommand::GetDetections { .. }
            | DbCommand::UpdateDetectionOverride { .. }
            | DbCommand::UpdatePetId { .. }
            | DbCommand::UpdateBehavior { .. }
            | DbCommand::DistinctPetIds { .. }
            | DbCommand::DistinctBehaviors { .. }
            | DbCommand::CaptionsForDate { .. }
            | DbCommand::ListUndetectedPhotos { .. }
            | DbCommand::MarkDetected { .. }
            | DbCommand::RecordEmptyLevel2 { .. }
            | DbCommand::GetEditHistory { .. }
            | DbCommand::GetBboxesForPhotos { .. }) => CommandDomain::Album(command),
            command @ (DbCommand::TrainingUpsertFrame { .. }
            | DbCommand::TrainingListFrames { .. }
            | DbCommand::TrainingGetFrame { .. }
            | DbCommand::TrainingUpdateStatus { .. }
            | DbCommand::TrainingListAnnotations { .. }
            | DbCommand::TrainingReplaceAnnotations { .. }
            | DbCommand::TrainingDeleteAnnotation { .. }
            | DbCommand::TrainingDeleteRejected { .. }
            | DbCommand::TrainingStats { .. }
            | DbCommand::TrainingExport { .. }
            | DbCommand::TrainingSetBgRef { .. }
            | DbCommand::TrainingListBgRefFrames { .. }
            | DbCommand::TrainingBgRefCount { .. }
            | DbCommand::TrainingBulkUpdateBgScores { .. }
            | DbCommand::TrainingBulkRejectByScore { .. }) => CommandDomain::Training(command),
        }
    }
}

fn run_database_loop(store: PhotoStore, rx: mpsc::Receiver<DbCommand>) {
    for command in rx {
        match command.into_domain() {
            CommandDomain::Album(command) => album::dispatch(&store, command),
            CommandDomain::Training(command) => training::dispatch(&store, command),
        }
    }
}

fn send_reply<T>(reply: oneshot::Sender<AppResult<T>>, result: rusqlite::Result<T>) {
    let _ = reply.send(result.map_err(|e| e.to_string()));
}
