use super::TrainingState;
use crate::application::db_thread::DbCommand;
use crate::training::ssh;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use std::sync::Arc;
use tracing::{error, info};

pub(super) async fn sync(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let frames =
        ssh::list_remote_frames(&state.ssh_host, &state.remote_dir, state.ssh_key.as_deref())
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let mut added = 0i64;
    for frame in &frames {
        let captured_at = if let Some(ref json_name) = frame.json_filename {
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
            .request(move |reply| DbCommand::TrainingUpsertFrame {
                filename,
                width: w,
                height: h,
                captured_at: ts,
                reply,
            })
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

#[derive(Deserialize)]
pub(super) struct FramesQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub(super) async fn list(
    State(state): State<Arc<TrainingState>>,
    Query(q): Query<FramesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let status = q.status.clone();
    let limit = q.limit.unwrap_or(50);
    let offset = q.offset.unwrap_or(0);
    let (frames, total) = state
        .db
        .request(move |reply| DbCommand::TrainingListFrames {
            status,
            limit,
            offset,
            reply,
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "frames": frames,
        "total": total,
    })))
}

pub(super) async fn get(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let frame = state
        .db
        .request(move |reply| DbCommand::TrainingGetFrame { id, reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    match frame {
        Some(f) => {
            let annotations = {
                let fid = f.id;
                state
                    .db
                    .request(move |reply| DbCommand::TrainingListAnnotations {
                        frame_id: fid,
                        reply,
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

#[derive(Deserialize)]
pub(super) struct StatusUpdate {
    status: String,
}

pub(super) async fn update_status(
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
        .request(move |reply| DbCommand::TrainingUpdateStatus { id, status, reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

pub(super) async fn image(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let frame = state
        .db
        .request(move |reply| DbCommand::TrainingGetFrame { id, reply })
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

#[derive(Deserialize)]
pub(super) struct CleanupRequest {
    #[serde(default = "default_true")]
    delete_remote: bool,
}

fn default_true() -> bool {
    true
}

pub(super) async fn cleanup(
    State(state): State<Arc<TrainingState>>,
    Json(body): Json<CleanupRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let filenames = state
        .db
        .request(move |reply| DbCommand::TrainingDeleteRejected { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let total = filenames.len();
    let cache_futs = filenames.iter().map(|f| {
        let path = state.cache_dir.join(f.replace(".nv12", ".jpg"));
        tokio::fs::remove_file(path)
    });
    futures_util::future::join_all(cache_futs).await;

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
