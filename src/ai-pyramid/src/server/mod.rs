use crate::application::{AppContext, EventQuery, EventStatusFilter, EventSummary};
use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub fn router(state: AppContext) -> Router {
    Router::new()
        .route("/album", get(handle_album_page))
        .route("/api/photos", get(handle_event_list))
        .route("/api/photos/{filename}", get(handle_photo_serve).patch(handle_event_validity_override))
        .route("/api/stats", get(handle_activity_stats))
        .route("/api/events", get(handle_sse))
        .route("/health", get(handle_health))
        .with_state(state)
}

#[derive(Deserialize)]
struct EventListQuery {
    is_valid: Option<String>,
    pet_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct EventListResponse {
    events: Vec<EventSummary>,
    total: i64,
}

#[derive(Template)]
#[template(path = "album.html")]
struct AlbumTemplate {
    events: Vec<EventSummary>,
    total: i64,
    filter_valid: String,
    filter_pet_id: String,
}

async fn handle_album_page(
    State(state): State<AppContext>,
    Query(query): Query<EventListQuery>,
) -> impl IntoResponse {
    let event_query = build_event_query(&query);
    let filter_valid = query.is_valid.unwrap_or_default();
    let filter_pet_id = query.pet_id.unwrap_or_default();
    let page_query = EventQuery {
        limit: Some(20),
        ..event_query
    };

    let event_queries = state.event_queries();
    let (mut events, total) = event_queries.list_events(page_query).await.unwrap_or_default();
    events.reverse();

    let template = AlbumTemplate {
        events,
        total,
        filter_valid,
        filter_pet_id,
    };
    Html(template.render().unwrap_or_else(|e| format!("Template error: {e}")))
}

async fn handle_event_list(
    State(state): State<AppContext>,
    Query(query): Query<EventListQuery>,
) -> impl IntoResponse {
    let event_query = build_event_query(&query);
    let event_queries = state.event_queries();
    match event_queries.list_events(event_query).await {
        Ok((events, total)) => Json(EventListResponse { events, total }).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn handle_photo_serve(
    State(state): State<AppContext>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let path = state.photos_dir().join(&safe_name);

    if !path.exists() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" })))
            .into_response();
    }

    match tokio::fs::read(&path).await {
        Ok(data) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            data,
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response(),
    }
}

#[derive(Deserialize)]
struct EventValidityOverride {
    is_valid: Option<bool>,
}

async fn handle_event_validity_override(
    State(state): State<AppContext>,
    Path(filename): Path<String>,
    Json(body): Json<EventValidityOverride>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let Some(is_valid) = body.is_valid else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "is_valid required" })),
        )
            .into_response();
    };

    let commands = state.observation_commands();
    match commands.override_event_validity(&safe_name, is_valid).await {
        Ok(true) => Json(serde_json::json!({ "ok": true, "is_valid": is_valid })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" })))
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn handle_activity_stats(State(state): State<AppContext>) -> impl IntoResponse {
    let event_queries = state.event_queries();
    match event_queries.activity_stats().await {
        Ok(stats) => Json(stats).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn handle_sse(
    State(state): State<AppContext>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = state.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(pet_event) => {
            let json = serde_json::to_string(&pet_event).unwrap_or_default();
            Some(Ok(Event::default().event("event").data(json)))
        }
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

fn build_event_query(query: &EventListQuery) -> EventQuery {
    let status = match query.is_valid.as_deref() {
        Some("pending") => EventStatusFilter::Pending,
        Some("true") | Some("1") => EventStatusFilter::Valid,
        Some("false") | Some("0") => EventStatusFilter::Invalid,
        _ => EventStatusFilter::All,
    };
    EventQuery {
        status,
        pet_id: query.pet_id.clone().filter(|value| !value.is_empty()),
        limit: query.limit,
        offset: query.offset,
    }
}

fn sanitize_filename(name: &str) -> String {
    std::path::Path::new(name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{ObservationInput, ObservationResult, PhotoStoreRepository};
    use crate::db::PhotoStore;
    use axum::body::Body;
    use axum::http::Request;
    use chrono::NaiveDate;
    use tower::util::ServiceExt;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, s)
            .unwrap()
    }

    fn test_state() -> AppContext {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let tempdir = tempfile::tempdir().unwrap();
        let photos_dir = tempdir.path().to_path_buf();
        std::mem::forget(tempdir);
        let (event_tx, _) = tokio::sync::broadcast::channel(16);
        AppContext::new(PhotoStoreRepository::shared(store), photos_dir, event_tx)
    }

    #[tokio::test]
    async fn health_endpoint() {
        let app = router(test_state());
        let response = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn event_list_empty() {
        let app = router(test_state());
        let response = app
            .oneshot(Request::builder().uri("/api/photos").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 0);
        assert_eq!(json["events"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn event_list_with_data() {
        let state = test_state();
        let commands = state.observation_commands();
        commands
            .ingest_source_photo(ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: Some("chatora".into()),
            })
            .await
            .unwrap();
        commands
            .ingest_source_photo(ObservationInput {
                source_filename: "b.jpg".into(),
                captured_at: dt(2026, 3, 21, 11, 0, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        commands
            .apply_observation(ObservationResult {
                source_filename: "a.jpg".into(),
                is_valid: true,
                summary: "cap".into(),
                behavior: "resting".into(),
            })
            .await
            .unwrap();

        let app = router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos?is_valid=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 1);
        assert_eq!(json["events"][0]["source_filename"], "a.jpg");
    }

    #[tokio::test]
    async fn photo_serve_not_found() {
        let app = router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos/nonexistent.jpg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn photo_serve_path_traversal() {
        let app = router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos/../../../etc/passwd")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn activity_stats_endpoint() {
        let state = test_state();
        state
            .observation_commands()
            .ingest_source_photo(ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: None,
            })
            .await
            .unwrap();

        let app = router(state);
        let response = app
            .oneshot(Request::builder().uri("/api/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_events"], 1);
        assert_eq!(json["pending_events"], 1);
    }

    #[tokio::test]
    async fn album_page_renders() {
        let app = router(test_state());
        let response = app
            .oneshot(Request::builder().uri("/album").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("Pet Album"));
    }
}
