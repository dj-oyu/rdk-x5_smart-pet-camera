use crate::application::{ActivityStats, EventSummary};
use crate::db::{DetectionInput, PhotoFilter, PhotoStore};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Router;
use futures_util::stream::Stream;
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

static EMBEDDED_UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/ui/dist");

#[derive(Debug, Clone, Serialize)]
pub struct PhotoEvent {
    pub filename: String,
    pub is_valid: bool,
    pub caption: String,
    pub behavior: String,
    pub pet_id: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<PhotoStore>>,
    pub photos_dir: PathBuf,
    pub event_tx: tokio::sync::broadcast::Sender<PhotoEvent>,
    pub base_url: Option<String>,
    pub is_tls: bool,
}

pub fn router(state: AppState) -> Router {
    let mcp_state = crate::mcp::McpState {
        store: state.store.clone(),
        photos_dir: state.photos_dir.clone(),
        base_url: state.base_url.clone(),
        is_tls: state.is_tls,
    };

    let mcp_router = Router::new()
        .route("/mcp", post(crate::mcp::handle_mcp))
        .route("/mcp/photos/{id}", get(crate::mcp::handle_mcp_photo_download))
        .with_state(mcp_state);

    Router::new()
        .route("/app", get(handle_embedded_app))
        .route("/app/{*path}", get(handle_embedded_asset))
        .route("/api/photos", get(handle_photos_list))
        .route("/api/photos/{filename}", get(handle_photo_serve).patch(handle_photo_update))
        .route("/api/photos/ingest", post(handle_ingest))
        .route("/api/detections/{id}", get(handle_detections_get).patch(handle_detection_update))
        .route("/api/stats", get(handle_stats))
        .route("/api/events", get(handle_sse))
        .route("/health", get(handle_health))
        .with_state(state)
        .merge(mcp_router)
}

#[derive(Deserialize)]
struct PhotosQuery {
    is_valid: Option<String>,
    pet_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct PhotosResponse {
    events: Vec<EventSummary>,
    total: i64,
}

async fn handle_embedded_app() -> Response {
    embedded_ui_response(None)
}

async fn handle_embedded_asset(Path(path): Path<String>) -> Response {
    embedded_ui_response(Some(path.as_str()))
}

fn embedded_ui_response(path: Option<&str>) -> Response {
    let requested = path.unwrap_or("index.html").trim_start_matches('/');
    let file = EMBEDDED_UI
        .get_file(requested)
        .or_else(|| EMBEDDED_UI.get_file("index.html"));

    match file {
        Some(file) => {
            let mime = mime_guess::from_path(file.path())
                .first_or_octet_stream()
                .to_string();
            let mut response = Response::new(file.contents().to_vec().into_response().into_body());
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&mime)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            response
        }
        None => (StatusCode::NOT_FOUND, "embedded asset not found").into_response(),
    }
}

// --- REST API ---


async fn handle_photos_list(
    State(state): State<AppState>,
    Query(q): Query<PhotosQuery>,
) -> impl IntoResponse {
    let filter = build_filter(&q);
    let store = state.store.lock().unwrap();
    match store.list(&filter) {
        Ok((photos, total)) => {
            let resp = PhotosResponse {
                events: photos.into_iter().map(EventSummary::from).collect(),
                total,
            };
            Json(resp).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn handle_photo_serve(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let path = state.photos_dir.join(&safe_name);

    if !path.exists() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response();
    }

    match tokio::fs::read(&path).await {
        Ok(data) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            data,
        ).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response(),
    }
}

#[derive(Deserialize)]
struct PhotoUpdate {
    is_valid: Option<bool>,
    pet_id: Option<String>,
}

async fn handle_photo_update(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    Json(body): Json<PhotoUpdate>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let store = state.store.lock().unwrap();

    // Verify photo exists
    match store.get_by_filename(&safe_name) {
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Ok(Some(_)) => {}
    }

    let mut updated = serde_json::json!({"ok": true});

    if let Some(is_valid) = body.is_valid {
        if let Err(e) = store.set_validation_override(&safe_name, is_valid) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        updated["is_valid"] = serde_json::json!(is_valid);
    }

    if let Some(ref pet_id) = body.pet_id {
        if let Err(e) = store.update_pet_id(&safe_name, pet_id) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        updated["pet_id"] = serde_json::json!(pet_id);
    }

    if body.is_valid.is_none() && body.pet_id.is_none() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "is_valid or pet_id required"}))).into_response();
    }

    Json(updated).into_response()
}

// POST /api/photos/ingest — rdk-x5 sends comic metadata + detections
#[derive(Deserialize)]
struct IngestRequest {
    filename: String,
    captured_at: String,
    pet_id: Option<String>,
    detections: Vec<DetectionInput>,
}

async fn handle_ingest(
    State(state): State<AppState>,
    Json(body): Json<IngestRequest>,
) -> impl IntoResponse {
    let captured_at = match chrono::NaiveDateTime::parse_from_str(&body.captured_at, "%Y-%m-%dT%H:%M:%S") {
        Ok(dt) => dt,
        Err(_) => match chrono::NaiveDateTime::parse_from_str(&body.captured_at, "%Y-%m-%dT%H:%M:%S%.f") {
            Ok(dt) => dt,
            Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("invalid captured_at: {e}")}))).into_response(),
        },
    };

    let safe_name = sanitize_filename(&body.filename);
    let store = state.store.lock().unwrap();

    match store.ingest_with_detections(
        &safe_name,
        captured_at,
        body.pet_id.as_deref(),
        &body.detections,
    ) {
        Ok(photo_id) => Json(serde_json::json!({
            "ok": true,
            "photo_id": photo_id,
            "detections_count": body.detections.len(),
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// GET /api/detections/:id — get detections for a photo
async fn handle_detections_get(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let store = state.store.lock().unwrap();
    match store.get_detections(id) {
        Ok(dets) => Json(dets).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// PATCH /api/detections/:id — update pet_id_override on a detection
#[derive(Deserialize)]
struct DetectionUpdate {
    pet_id_override: String,
}

async fn handle_detection_update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<DetectionUpdate>,
) -> impl IntoResponse {
    let store = state.store.lock().unwrap();
    match store.update_detection_override(id, &body.pet_id_override) {
        Ok(0) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "detection not found"}))).into_response(),
        Ok(_) => Json(serde_json::json!({"ok": true, "pet_id_override": body.pet_id_override})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn handle_stats(State(state): State<AppState>) -> impl IntoResponse {
    let store = state.store.lock().unwrap();
    match store.stats() {
        Ok(stats) => Json(ActivityStats::from(stats)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn handle_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| {
        match result {
            Ok(photo_event) => {
                let json = serde_json::to_string(&photo_event).unwrap_or_default();
                Some(Ok(Event::default().event("event").data(json)))
            }
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({"ok": true}))
}

fn build_filter(q: &PhotosQuery) -> PhotoFilter {
    let is_pending = q.is_valid.as_deref() == Some("pending");
    PhotoFilter {
        is_valid: if is_pending { None } else {
            q.is_valid.as_ref().and_then(|v| match v.as_str() {
                "true" | "1" => Some(true),
                "false" | "0" => Some(false),
                _ => None,
            })
        },
        is_pending,
        pet_id: q.pet_id.clone().filter(|s| !s.is_empty()),
        limit: q.limit,
        offset: q.offset,
    }
}

fn sanitize_filename(name: &str) -> String {
    std::path::Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use chrono::NaiveDate;
    use futures_util::StreamExt;
    use tower::util::ServiceExt;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, s).unwrap()
    }

    fn test_state() -> AppState {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let td = tempfile::tempdir().unwrap();
        let photos_dir = td.path().to_path_buf();
        std::mem::forget(td);
        let (event_tx, _) = tokio::sync::broadcast::channel(16);
        AppState {
            store: Arc::new(Mutex::new(store)),
            photos_dir,
            event_tx,
            base_url: None,
            is_tls: false,
        }
    }

    #[tokio::test]
    async fn embedded_app_serves_index() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/app").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("<div id=\"app\"></div>"));
        assert!(html.contains("/app/main."));
    }

    #[tokio::test]
    async fn health_endpoint() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn photos_list_empty_returns_events_shape() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/api/photos").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 0);
        assert!(json["events"].is_array());
        assert_eq!(json["events"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn photos_list_returns_frontend_event_contract() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
            store.update_vlm_result("a.jpg", true, "tabby cat resting", "resting").unwrap();
        }
        let app = router(state);
        let resp = app
            .oneshot(Request::builder().uri("/api/photos?is_valid=true").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 1);
        let event = &json["events"][0];
        assert_eq!(event["source_filename"], "a.jpg");
        assert_eq!(event["status"], "valid");
        assert_eq!(event["pet_id"], "chatora");
        assert_eq!(event["behavior"], "resting");
        assert_eq!(event["summary"], "tabby cat resting");
        assert!(event["observed_at"].as_str().unwrap().starts_with("2026-03-21T10:00:00"));
    }

    #[tokio::test]
    async fn photo_serve_not_found() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/api/photos/nonexistent.jpg").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn photo_serve_path_traversal() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/api/photos/../../../etc/passwd").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn stats_endpoint_returns_frontend_contract() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), None).unwrap();
        }
        let app = router(state);
        let resp = app
            .oneshot(Request::builder().uri("/api/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_events"], 1);
        assert_eq!(json["pending_events"], 1);
        assert_eq!(json["confirmed_events"], 0);
        assert_eq!(json["rejected_events"], 0);
    }

    #[tokio::test]
    async fn sse_uses_frontend_event_name() {
        let state = test_state();
        let tx = state.event_tx.clone();
        let app = router(state);
        let resp = app
            .oneshot(Request::builder().uri("/api/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let mut stream = resp.into_body().into_data_stream();

        tx.send(PhotoEvent {
            filename: "a.jpg".into(),
            is_valid: true,
            caption: "tabby cat resting".into(),
            behavior: "resting".into(),
            pet_id: Some("chatora".into()),
        }).unwrap();

        let chunk = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let text = String::from_utf8_lossy(&chunk);
        assert!(text.contains("event: event"));
        assert!(text.contains("\"filename\":\"a.jpg\""));
    }
}
