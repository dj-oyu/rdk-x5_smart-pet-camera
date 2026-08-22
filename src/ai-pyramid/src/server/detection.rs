use super::{AppState, PhotoEvent, sanitize_filename};
use crate::ingest::filename::parse_comic_filename;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use std::sync::atomic::Ordering;

// POST /api/backfill — trigger detection backfill for photos without detections
pub(super) async fn handle_backfill(State(state): State<AppState>) -> impl IntoResponse {
    // Need either local detector or remote detect client
    let local = state.local_detector.clone();
    let remote = state.detect_client.clone();
    if local.is_none() && remote.is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "detection not configured"})),
        )
            .into_response();
    }

    // Prevent concurrent backfill runs
    if state
        .backfill_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "backfill already running"})),
        )
            .into_response();
    }

    let backfill_flag = state.backfill_running.clone();
    let context = state.context.clone();
    let photos_dir = state.photos_dir.clone();
    let sse_tx = state.event_tx.clone();
    tokio::spawn(async move {
        let queries = context.event_queries();
        let commands = context.observation_commands();
        let photos = match queries.list_undetected_photos(500).await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("Backfill query failed: {e}");
                backfill_flag.store(false, Ordering::SeqCst);
                return;
            }
        };

        let total = photos.len();
        tracing::info!(
            "Backfill: {total} photos to process (local={}, remote={})",
            local.is_some(),
            remote.is_some()
        );
        let mut ok = 0u32;
        let mut fail = 0u32;

        for (idx, photo) in photos.iter().enumerate() {
            // Skip invalid photos
            if photo.status == crate::application::EventStatus::Invalid {
                let _ = commands.mark_detected(photo.id).await;
                continue;
            }

            // Detect: prefer local (level2), fallback to remote (level1)
            let dets = if let Some(ref ld) = local {
                let _permit = context.yolo_semaphore().acquire().await;
                ld.detect_comic(&photos_dir, &photo.source_filename).await
            } else if let Some(ref rc) = remote {
                rc.detect(&photo.source_filename).await
            } else {
                Err("no detector".into())
            };

            match dets {
                Ok(dets) if !dets.is_empty() => {
                    let captured_at = parse_comic_filename(&photo.source_filename)
                        .map(|m| m.captured_at)
                        .unwrap_or_default();
                    if let Err(e) = commands
                        .ingest_with_detections(
                            &photo.source_filename,
                            captured_at,
                            photo.pet_id.as_deref(),
                            &dets,
                        )
                        .await
                    {
                        tracing::warn!("Backfill DB error {}: {e}", photo.source_filename);
                        fail += 1;
                    } else {
                        tracing::info!(
                            "Backfill [{}/{}] OK: {} ({} dets)",
                            idx + 1,
                            total,
                            photo.source_filename,
                            dets.len()
                        );
                        ok += 1;
                    }
                }
                Ok(_) => {
                    tracing::info!(
                        "Backfill [{}/{}]: no detections for {}",
                        idx + 1,
                        total,
                        photo.source_filename
                    );
                    let _ = commands.mark_detected(photo.id).await;
                }
                Err(e) => {
                    tracing::warn!(
                        "Backfill [{}/{}] detect error {}: {e}",
                        idx + 1,
                        total,
                        photo.source_filename
                    );
                    fail += 1;
                }
            }

            // SSE progress event
            let _ = sse_tx.send(PhotoEvent::Update {
                filename: photo.source_filename.clone(),
                is_valid: photo.status == crate::application::EventStatus::Valid,
                caption: String::new(),
                behavior: String::new(),
                pet_id: photo.pet_id.clone(),
            });

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        tracing::info!("Backfill complete: {ok} ok, {fail} failed, {total} total");
        backfill_flag.store(false, Ordering::SeqCst);
    });

    Json(serde_json::json!({"ok": true, "message": "backfill started"})).into_response()
}

pub(super) async fn handle_backfill_status(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "running": state.backfill_running.load(Ordering::SeqCst)
    }))
}

/// POST /api/detect-now/{filename} — run Level2 detection with progressive SSE updates.
/// Each detection is streamed as a `detection-partial` SSE event as soon as found.
/// On completion, saves to DB and sends `detection-ready`.
pub(super) async fn handle_detect_now(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let local = match &state.local_detector {
        Some(ld) => ld.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "local detector not available"})),
            )
                .into_response();
        }
    };

    let safe_name = sanitize_filename(&filename);
    let photos_dir = state.photos_dir.clone();
    let commands = state.commands();
    let sse_tx = state.event_tx.clone();
    let yolo_semaphore = state.context.yolo_semaphore().clone();

    // Channel for streaming partial detections
    let (det_tx, mut det_rx) = tokio::sync::mpsc::channel::<crate::db::DetectionInput>(64);
    let sse_tx2 = sse_tx.clone();
    let fname = safe_name.clone();

    // Forward partial detections to SSE as they arrive
    let relay = tokio::spawn(async move {
        while let Some(det) = det_rx.recv().await {
            let _ = sse_tx2.send(PhotoEvent::DetectionPartial {
                filename: fname.clone(),
                bbox_x: det.bbox_x,
                bbox_y: det.bbox_y,
                bbox_w: det.bbox_w,
                bbox_h: det.bbox_h,
                yolo_class: det.yolo_class.clone().unwrap_or_default(),
                confidence: det.confidence.unwrap_or(0.0),
            });
        }
    });

    let _permit = yolo_semaphore.acquire().await;

    // Run streaming detection
    let result = local
        .detect_comic_stream(&photos_dir, &safe_name, &det_tx)
        .await;
    drop(det_tx); // close channel so relay task finishes
    let _ = relay.await;

    match result {
        Ok(dets) => {
            let det_count = dets.len();
            if !dets.is_empty() {
                let captured_at = parse_comic_filename(&safe_name)
                    .map(|m| m.captured_at)
                    .unwrap_or_default();
                if let Err(e) = commands
                    .ingest_with_detections(&safe_name, captured_at, None, &dets)
                    .await
                {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": format!("DB error: {e}")})),
                    )
                        .into_response();
                }
            } else if let Some(event) = state
                .queries()
                .get_event_by_source(&safe_name)
                .await
                .ok()
                .flatten()
            {
                let _ = commands.mark_detected(event.id).await;
            }

            // Signal completion
            let _ = sse_tx.send(PhotoEvent::DetectionReady {
                filename: safe_name.clone(),
                count: det_count,
            });

            Json(serde_json::json!({
                "ok": true,
                "filename": safe_name,
                "detections": det_count,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}
