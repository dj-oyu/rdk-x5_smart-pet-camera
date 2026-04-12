use crate::application::db_thread::Database;
use crate::training::db::AnnotationInput;
use crate::training::ssh;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json};
use axum::routing::{delete, get, post, put};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{error, info};

#[derive(Clone)]
pub struct TrainingState {
    pub db: Database,
    pub ssh_host: String,
    pub remote_dir: String,
    pub cache_dir: PathBuf,
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
        .route("/api/training/stats", get(handle_stats))
        .route("/api/training/export", get(handle_export))
        .route("/api/training/classes", get(handle_classes))
        .with_state(Arc::new(state))
}

// ── Sync: discover remote frames and register in DB ──────────────

async fn handle_sync(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let frames = ssh::list_remote_frames(&state.ssh_host, &state.remote_dir)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let mut added = 0i64;
    for frame in &frames {
        let captured_at = if let Some(ref json_name) = frame.json_filename {
            // Try to extract timestamp from JSON
            match ssh::fetch_frame_metadata(&state.ssh_host, &state.remote_dir, json_name).await {
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
