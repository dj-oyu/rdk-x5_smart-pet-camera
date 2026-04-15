use crate::application::db_thread::Database;
use crate::training::db::AnnotationInput;
use crate::training::{bg, ssh};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json};
use axum::routing::{delete, get, post, put};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{error, info, warn};

#[derive(Clone)]
pub struct TrainingState {
    pub db: Database,
    pub ssh_host: String,
    pub remote_dir: String,
    pub cache_dir: PathBuf,
    /// Path to SSH identity file (e.g. /home/admin-user/.ssh/id_ed25519).
    /// When set, passed as `-i <key>` to ssh/scp. Required when the service
    /// runs as a user (e.g. root) that has no key for the remote host.
    pub ssh_key: Option<String>,
}

pub fn router(state: TrainingState) -> Router {
    Router::new()
        .route("/api/training/sync", post(handle_sync))
        .route("/api/training/frames", get(handle_list_frames))
        .route("/api/training/frames/{id}", get(handle_get_frame))
        .route(
            "/api/training/frames/{id}/status",
            put(handle_update_status),
        )
        .route("/api/training/frames/{id}/image", get(handle_frame_image))
        .route(
            "/api/training/frames/{id}/annotations",
            get(handle_list_annotations).put(handle_replace_annotations),
        )
        .route(
            "/api/training/annotations/{id}",
            delete(handle_delete_annotation),
        )
        .route("/api/training/cleanup", post(handle_cleanup))
        .route("/api/training/stats", get(handle_stats))
        .route("/api/training/export", get(handle_export))
        .route("/api/training/classes", get(handle_classes))
        // Background model routes
        .route("/api/training/frames/{id}/bg_ref", put(handle_set_bg_ref))
        .route("/api/training/bg/status", get(handle_bg_status))
        .route("/api/training/bg/build", post(handle_bg_build))
        .route("/api/training/bg/score", post(handle_bg_score))
        .route("/api/training/bg/reject", post(handle_bg_reject))
        .with_state(Arc::new(state))
}

// ── Sync: discover remote frames and register in DB ──────────────

async fn handle_sync(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let frames =
        ssh::list_remote_frames(&state.ssh_host, &state.remote_dir, state.ssh_key.as_deref())
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let mut added = 0i64;
    for frame in &frames {
        let captured_at = if let Some(ref json_name) = frame.json_filename {
            // Try to extract timestamp from JSON
            match ssh::fetch_frame_metadata(
                &state.ssh_host,
                &state.remote_dir,
                json_name,
                state.ssh_key.as_deref(),
            )
            .await
            {
                Ok(meta) => meta
                    .get("timestamp")
                    .and_then(|v| v.as_f64())
                    .and_then(|ts| {
                        chrono::DateTime::from_timestamp(ts as i64, 0)
                            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
                    }),
                Err(_) => None,
            }
        } else {
            None
        };

        let db = state.db.clone();
        let filename = frame.filename.clone();
        let w = frame.width;
        let h = frame.height;
        let ts = captured_at.clone();
        let result = db
            .request(
                move |reply| crate::application::db_thread::DbCommand::TrainingUpsertFrame {
                    filename,
                    width: w,
                    height: h,
                    captured_at: ts,
                    reply,
                },
            )
            .await;

        match result {
            Ok(_) => added += 1,
            Err(e) => error!("failed to upsert frame {}: {e}", frame.filename),
        }
    }

    info!(
        "training sync: {added} frames registered from {}",
        state.remote_dir
    );
    Ok(Json(serde_json::json!({
        "synced": added,
        "total_remote": frames.len(),
    })))
}

// ── Frame listing ────────────────────────────────────────────────

#[derive(Deserialize)]
struct FramesQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn handle_list_frames(
    State(state): State<Arc<TrainingState>>,
    Query(q): Query<FramesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let status = q.status.clone();
    let limit = q.limit.unwrap_or(50);
    let offset = q.offset.unwrap_or(0);
    let (frames, total) = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingListFrames {
                status,
                limit,
                offset,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "frames": frames,
        "total": total,
    })))
}

// ── Single frame ─────────────────────────────────────────────────

async fn handle_get_frame(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let frame = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingGetFrame { id, reply },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    match frame {
        Some(f) => {
            let annotations = {
                let fid = f.id;
                state
                    .db
                    .request(move |reply| {
                        crate::application::db_thread::DbCommand::TrainingListAnnotations {
                            frame_id: fid,
                            reply,
                        }
                    })
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
            };
            Ok(Json(serde_json::json!({
                "frame": f,
                "annotations": annotations,
            })))
        }
        None => Err((StatusCode::NOT_FOUND, "frame not found".to_string())),
    }
}

// ── Update frame status ──────────────────────────────────────────

#[derive(Deserialize)]
struct StatusUpdate {
    status: String,
}

async fn handle_update_status(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
    Json(body): Json<StatusUpdate>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let valid = matches!(body.status.as_str(), "pending" | "approved" | "rejected");
    if !valid {
        return Err((
            StatusCode::BAD_REQUEST,
            "status must be pending/approved/rejected".to_string(),
        ));
    }
    let status = body.status.clone();
    state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingUpdateStatus {
                id,
                status,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

// ── Serve frame image (fetch + convert on demand) ────────────────

async fn handle_frame_image(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let frame = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingGetFrame { id, reply },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "frame not found".to_string()))?;

    let jpeg_path = ssh::fetch_and_convert_frame(
        &state.ssh_host,
        &state.remote_dir,
        &frame.filename,
        frame.width,
        frame.height,
        &state.cache_dir,
        state.ssh_key.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let bytes = tokio::fs::read(&jpeg_path).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("read cached jpeg: {e}"),
        )
    })?;

    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400, immutable"),
            ),
        ],
        bytes,
    ))
}

// ── Annotations ──────────────────────────────────────────────────

async fn handle_list_annotations(
    State(state): State<Arc<TrainingState>>,
    Path(frame_id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let annotations = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingListAnnotations {
                frame_id,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"annotations": annotations})))
}

async fn handle_replace_annotations(
    State(state): State<Arc<TrainingState>>,
    Path(frame_id): Path<i64>,
    Json(body): Json<Vec<AnnotationInput>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Validate all coordinates are in [0, 1]
    for ann in &body {
        if ann.x_center < 0.0
            || ann.x_center > 1.0
            || ann.y_center < 0.0
            || ann.y_center > 1.0
            || ann.width < 0.0
            || ann.width > 1.0
            || ann.height < 0.0
            || ann.height > 1.0
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "coordinates must be normalized (0.0-1.0)".to_string(),
            ));
        }
    }

    let annotations = body.clone();
    state
        .db
        .request(move |reply| {
            crate::application::db_thread::DbCommand::TrainingReplaceAnnotations {
                frame_id,
                annotations,
                reply,
            }
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true, "count": body.len()})))
}

async fn handle_delete_annotation(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingDeleteAnnotation {
                id,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

// ── Cleanup: delete all rejected frames ──────────────────────────

#[derive(Deserialize)]
struct CleanupRequest {
    /// Also delete the original NV12 file on rdk-x5 (default: true).
    #[serde(default = "default_true")]
    delete_remote: bool,
}
fn default_true() -> bool {
    true
}

async fn handle_cleanup(
    State(state): State<Arc<TrainingState>>,
    Json(body): Json<CleanupRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // 1. Single DB transaction: collect filenames then delete all rejected rows.
    //    Annotations are removed via ON DELETE CASCADE.
    let filenames = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingDeleteRejected { reply },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let total = filenames.len();

    // 2. Remove local JPEG caches in parallel (best-effort).
    let cache_futs = filenames.iter().map(|f| {
        let path = state.cache_dir.join(f.replace(".nv12", ".jpg"));
        tokio::fs::remove_file(path)
    });
    futures_util::future::join_all(cache_futs).await;

    // 3. Delete remote NV12 files in a single batched SSH command (chunked).
    let (remote_deleted, remote_errors) = if body.delete_remote && !filenames.is_empty() {
        ssh::delete_remote_frames(
            &state.ssh_host,
            &state.remote_dir,
            &filenames,
            state.ssh_key.as_deref(),
        )
        .await
    } else {
        (0, vec![])
    };

    info!("training cleanup: deleted {total} rejected frames, {remote_deleted} remote files");
    Ok(Json(serde_json::json!({
        "deleted": total,
        "remote_deleted": remote_deleted,
        "remote_errors": remote_errors,
    })))
}

// ── Stats ────────────────────────────────────────────────────────

async fn handle_stats(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stats = state
        .db
        .request(move |reply| crate::application::db_thread::DbCommand::TrainingStats { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!(stats)))
}

// ── Export YOLO format ───────────────────────────────────────────

async fn handle_export(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let dataset = state
        .db
        .request(move |reply| crate::application::db_thread::DbCommand::TrainingExport { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Build sorted class list first — needed for numeric index assignment.
    // YOLO label format: "<class_index> x_center y_center width height"
    let classes: Vec<String> = dataset
        .iter()
        .flat_map(|(_, _, _, anns)| anns.iter().map(|a| a.class_label.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let class_index: std::collections::HashMap<&str, usize> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
        .collect();

    let mut files = Vec::new();
    for (filename, _w, _h, annotations) in &dataset {
        let label_filename = filename.replace(".nv12", ".txt");
        let lines: Vec<String> = annotations
            .iter()
            .filter_map(|a| {
                class_index.get(a.class_label.as_str()).map(|&idx| {
                    format!(
                        "{} {:.6} {:.6} {:.6} {:.6}",
                        idx, a.x_center, a.y_center, a.width, a.height
                    )
                })
            })
            .collect();
        files.push(serde_json::json!({
            "image": filename,
            "label_file": label_filename,
            "labels": lines,
        }));
    }

    Ok(Json(serde_json::json!({
        "total_frames": dataset.len(),
        "total_annotations": dataset.iter().map(|(_, _, _, a)| a.len()).sum::<usize>(),
        "classes": classes,
        "files": files,
    })))
}

// ── Distinct class labels ────────────────────────────────────────

async fn handle_classes(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stats = state
        .db
        .request(move |reply| crate::application::db_thread::DbCommand::TrainingStats { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let classes: Vec<&str> = stats
        .class_counts
        .iter()
        .map(|c| c.class_label.as_str())
        .collect();

    Ok(Json(serde_json::json!({"classes": classes})))
}

// ── Background model ─────────────────────────────────────────────

// PUT /api/training/frames/{id}/bg_ref
#[derive(Deserialize)]
struct BgRefUpdate {
    is_bg_ref: bool,
}

async fn handle_set_bg_ref(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
    Json(body): Json<BgRefUpdate>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingSetBgRef {
                id,
                is_bg_ref: body.is_bg_ref,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

// GET /api/training/bg/status
async fn handle_bg_status(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let model_path = bg::model_path(&state.cache_dir);
    let model_exists = model_path.exists();

    let (model_frame_count, model_width, model_height) = if model_exists {
        match bg::load_model(&model_path) {
            Ok(m) => (m.frame_count, m.width, m.height),
            Err(_) => (0, 0, 0),
        }
    } else {
        (0, 0, 0)
    };

    let bg_ref_count = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingBgRefCount { reply },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Simple staleness: model was built from a different number of refs than currently marked
    let stale = model_exists && (model_frame_count as i64 != bg_ref_count);

    Ok(Json(serde_json::json!({
        "model_exists": model_exists,
        "model_frame_count": model_frame_count,
        "model_width": model_width,
        "model_height": model_height,
        "bg_ref_count": bg_ref_count,
        "stale": stale,
        "min_refs_required": bg::MIN_REF_FRAMES,
    })))
}

// POST /api/training/bg/build
async fn handle_bg_build(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let refs =
        state
            .db
            .request(move |reply| {
                crate::application::db_thread::DbCommand::TrainingListBgRefFrames { reply }
            })
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if refs.len() < bg::MIN_REF_FRAMES {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "need at least {} background reference frames, only {} marked",
                bg::MIN_REF_FRAMES,
                refs.len()
            ),
        ));
    }

    // Ensure all reference frames are cached; fetch missing ones on demand.
    let mut jpeg_paths = Vec::with_capacity(refs.len());
    let mut fetched = 0usize;
    for (id, filename) in &refs {
        let jpeg_name = filename.replace(".nv12", ".jpg");
        let cached = state.cache_dir.join(&jpeg_name);
        if cached.exists() {
            jpeg_paths.push(cached);
        } else {
            // Need to know dimensions — look up the frame
            let fid = *id;
            let frame = state
                .db
                .request(
                    move |reply| crate::application::db_thread::DbCommand::TrainingGetFrame {
                        id: fid,
                        reply,
                    },
                )
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        format!("bg_ref frame {id} not found in DB"),
                    )
                })?;

            let path = ssh::fetch_and_convert_frame(
                &state.ssh_host,
                &state.remote_dir,
                &frame.filename,
                frame.width,
                frame.height,
                &state.cache_dir,
                state.ssh_key.as_deref(),
            )
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
            fetched += 1;
            jpeg_paths.push(path);
        }
    }

    // Build model on a blocking thread (CPU-bound image processing)
    let model = tokio::task::spawn_blocking(move || bg::build_model(&jpeg_paths))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("spawn_blocking: {e}"),
            )
        })?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;

    let model_path = bg::model_path(&state.cache_dir);
    bg::save_model(&model, &model_path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    info!(
        "background model built from {} frames ({}x{}), {} fetched from remote",
        model.frame_count, model.width, model.height, fetched
    );
    Ok(Json(serde_json::json!({
        "ok": true,
        "frame_count": model.frame_count,
        "width": model.width,
        "height": model.height,
        "fetched_from_remote": fetched,
    })))
}

// POST /api/training/bg/score
async fn handle_bg_score(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let model_path = bg::model_path(&state.cache_dir);
    let model = bg::load_model(&model_path).map_err(|e| {
        (
            StatusCode::PRECONDITION_FAILED,
            format!("no background model: {e}"),
        )
    })?;

    // List all pending frames
    let (pending_frames, _) = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingListFrames {
                status: Some("pending".into()),
                limit: 100_000,
                offset: 0,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let cache_dir = state.cache_dir.clone();
    let scores_result = tokio::task::spawn_blocking(move || {
        let mut scores: Vec<(i64, f64)> = Vec::new();
        let mut skipped = 0usize;

        for frame in &pending_frames {
            let jpeg_name = frame.filename.replace(".nv12", ".jpg");
            let cached = cache_dir.join(&jpeg_name);
            if !cached.exists() {
                skipped += 1;
                continue;
            }
            match bg::score_frame(&model, &cached) {
                Ok(s) => scores.push((frame.id, s as f64)),
                Err(e) => warn!("score_frame failed for {}: {e}", frame.filename),
            }
        }
        (scores, skipped)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("spawn_blocking: {e}"),
        )
    })?;

    let (scores, skipped) = scores_result;
    let scored = scores.len();

    state
        .db
        .request(move |reply| {
            crate::application::db_thread::DbCommand::TrainingBulkUpdateBgScores { scores, reply }
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    info!("bg scoring complete: {scored} scored, {skipped} skipped (not cached)");
    Ok(Json(serde_json::json!({
        "scored": scored,
        "skipped_not_cached": skipped,
    })))
}

// POST /api/training/bg/reject  { "threshold": 5.0 }
#[derive(Deserialize)]
struct RejectByScoreRequest {
    threshold: f64,
}

async fn handle_bg_reject(
    State(state): State<Arc<TrainingState>>,
    Json(body): Json<RejectByScoreRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if body.threshold < 0.0 || body.threshold > 100.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "threshold must be 0.0–100.0".to_string(),
        ));
    }

    let rejected = state
        .db
        .request(
            move |reply| crate::application::db_thread::DbCommand::TrainingBulkRejectByScore {
                threshold: body.threshold,
                reply,
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    info!(
        "bg auto-reject: {rejected} frames rejected (score <= {}%)",
        body.threshold
    );
    Ok(Json(serde_json::json!({
        "rejected": rejected,
        "threshold": body.threshold,
    })))
}
