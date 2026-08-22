use super::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::time::Instant;

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

    // Check cache (2-hour TTL)
    {
        let cache = state.daily_summary_cache.lock().await;
        if let Some((ref d, cached_at, ref json)) = *cache
            && d == &date
            && cached_at.elapsed() < std::time::Duration::from_secs(2 * 3600)
        {
            return Json(json.clone()).into_response();
        }
    }

    let captions = match state.queries().captions_for_date(&date).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    if captions.is_empty() {
        return Json(DailySummaryResponse {
            date,
            summary: "No observations for this date.".into(),
            photo_count: 0,
        })
        .into_response();
    }

    let photo_count = captions.len();

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
                .summarize_day_with_swap(swap, &captions, random_photo.as_deref())
                .await
        }
        None => {
            vlm_client
                .summarize_day(&captions, random_photo.as_deref())
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
                .replace((date, Instant::now(), json));
            Json(resp).into_response()
        }
        Err(e) => {
            // Fallback: return captions list
            let fallback = format!("{photo_count} observations recorded. VLM unavailable: {e}");
            Json(DailySummaryResponse {
                date,
                summary: fallback,
                photo_count,
            })
            .into_response()
        }
    }
}
