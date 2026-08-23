use super::AppState;
use crate::vlm::Observation;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// How long a generated summary is reused. Long, because generating one costs
/// an NPU window that per-photo captioning would otherwise use.
const SUMMARY_TTL: Duration = Duration::from_secs(2 * 3600);

/// How long a *failed* summary is reused. Failures are cached too: the album
/// requests the summary on every page load, and each attempt holds the NPU
/// permit for the whole VLM timeout, so an un-cached failure lets refreshes
/// stall photo ingest. Short enough that a recovered VLM is picked up soon.
const SUMMARY_FAILURE_TTL: Duration = Duration::from_secs(5 * 60);

pub(super) struct CachedSummary {
    date: String,
    cached_at: Instant,
    ttl: Duration,
    json: serde_json::Value,
}

#[derive(Deserialize)]
pub(super) struct DailySummaryRequest {
    date: Option<String>,
}

#[derive(Serialize)]
struct DailySummaryResponse {
    date: String,
    summary: String,
    photo_count: usize,
}

pub(super) async fn handle_daily_summary(
    State(state): State<AppState>,
    Json(body): Json<DailySummaryRequest>,
) -> impl IntoResponse {
    let date = body
        .date
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

    // Check cache — both successes and failures land here, with their own TTLs
    {
        let cache = state.daily_summary_cache.lock().await;
        if let Some(ref cached) = *cache
            && cached.date == date
            && cached.cached_at.elapsed() < cached.ttl
        {
            return Json(cached.json.clone()).into_response();
        }
    }

    let rows = match state.queries().observations_for_date(&date).await {
        Ok(rows) => rows,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    if rows.is_empty() {
        return Json(DailySummaryResponse {
            date,
            summary: "No observations for this date.".into(),
            photo_count: 0,
        })
        .into_response();
    }

    let photo_count = rows.len();
    let day: Vec<Observation> = rows
        .into_iter()
        .map(|row| Observation {
            captured_at: row.captured_at,
            caption: row.caption,
        })
        .collect();

    // Pick a random photo from the day for visual context
    let random_photo = {
        let date_prefix = format!("comic_{}", date.replace('-', ""));
        let mut candidates: Vec<_> = std::fs::read_dir(&state.photos_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&date_prefix))
            .collect();
        if !candidates.is_empty() {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            date.hash(&mut h);
            let idx = h.finish() as usize % candidates.len();
            Some(candidates.swap_remove(idx).path())
        } else {
            None
        }
    };

    let vlm_config = state.context.vlm_config();
    let vlm_client = crate::vlm::VlmClient::new(vlm_config);
    let _permit = state.context.vlm_semaphore().acquire().await.unwrap();
    let summary_result = match state.context.vlm_swap_config() {
        Some(swap) => {
            vlm_client
                .summarize_day_with_swap(swap, &day, random_photo.as_deref())
                .await
        }
        None => {
            vlm_client
                .summarize_day(&day, random_photo.as_deref())
                .await
        }
    };
    match summary_result {
        Ok(summary) => {
            let resp = DailySummaryResponse {
                date: date.clone(),
                summary,
                photo_count,
            };
            let json = serde_json::to_value(&resp).unwrap();
            state
                .daily_summary_cache
                .lock()
                .await
                .replace(CachedSummary {
                    date,
                    cached_at: Instant::now(),
                    ttl: SUMMARY_TTL,
                    json,
                });
            Json(resp).into_response()
        }
        Err(e) => {
            // Fallback: return captions list. The album shows this string in
            // place of the summary, so also record it server-side — otherwise
            // a failed summary leaves no trace in the journal at all.
            tracing::warn!(date = %date, photo_count, error = %e, "daily summary failed");
            let fallback = format!("{photo_count} observations recorded. VLM unavailable: {e}");
            let resp = DailySummaryResponse {
                date: date.clone(),
                summary: fallback,
                photo_count,
            };
            let json = serde_json::to_value(&resp).unwrap();
            state
                .daily_summary_cache
                .lock()
                .await
                .replace(CachedSummary {
                    date,
                    cached_at: Instant::now(),
                    ttl: SUMMARY_FAILURE_TTL,
                    json,
                });
            Json(resp).into_response()
        }
    }
}
