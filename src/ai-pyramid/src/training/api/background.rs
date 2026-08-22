use super::TrainingState;
use crate::application::db_thread::DbCommand;
use crate::training::{bg, ssh};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Deserialize)]
pub(super) struct BgRefUpdate {
    is_bg_ref: bool,
}

pub(super) async fn set_ref(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
    Json(body): Json<BgRefUpdate>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .db
        .request(move |reply| DbCommand::TrainingSetBgRef {
            id,
            is_bg_ref: body.is_bg_ref,
            reply,
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

pub(super) async fn status(
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
        .request(move |reply| DbCommand::TrainingBgRefCount { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

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

pub(super) async fn build(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let refs = state
        .db
        .request(move |reply| DbCommand::TrainingListBgRefFrames { reply })
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

    let mut jpeg_paths = Vec::with_capacity(refs.len());
    let mut fetched = 0usize;
    for (id, filename) in &refs {
        let jpeg_name = filename.replace(".nv12", ".jpg");
        let cached = state.cache_dir.join(&jpeg_name);
        if cached.exists() {
            jpeg_paths.push(cached);
        } else {
            let fid = *id;
            let frame = state
                .db
                .request(move |reply| DbCommand::TrainingGetFrame { id: fid, reply })
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

pub(super) async fn score(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let model_path = bg::model_path(&state.cache_dir);
    let model = bg::load_model(&model_path).map_err(|e| {
        (
            StatusCode::PRECONDITION_FAILED,
            format!("no background model: {e}"),
        )
    })?;

    let (pending_frames, _) = state
        .db
        .request(move |reply| DbCommand::TrainingListFrames {
            status: Some("pending".into()),
            limit: 100_000,
            offset: 0,
            reply,
        })
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
        .request(move |reply| DbCommand::TrainingBulkUpdateBgScores { scores, reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    info!("bg scoring complete: {scored} scored, {skipped} skipped (not cached)");
    Ok(Json(serde_json::json!({
        "scored": scored,
        "skipped_not_cached": skipped,
    })))
}

#[derive(Deserialize)]
pub(super) struct RejectByScoreRequest {
    threshold: f64,
}

pub(super) async fn reject(
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
        .request(move |reply| DbCommand::TrainingBulkRejectByScore {
            threshold: body.threshold,
            reply,
        })
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
