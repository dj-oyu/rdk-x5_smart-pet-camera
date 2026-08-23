use crate::application::{AppContext, EventQueries, ObservationCommands};
use crate::detect::DetectClient;
use axum::Router;
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;

mod album;
mod assets;
mod detection;
mod events;
mod summary;
mod test_pages;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum PhotoEvent {
    #[serde(rename = "update")]
    Update {
        filename: String,
        is_valid: bool,
        caption: String,
        behavior: String,
        pet_id: Option<String>,
    },
    /// A single detection found during progressive scan
    #[serde(rename = "detection-partial")]
    DetectionPartial {
        filename: String,
        bbox_x: i32,
        bbox_y: i32,
        bbox_w: i32,
        bbox_h: i32,
        yolo_class: String,
        confidence: f64,
    },
    /// All detections complete for a photo
    #[serde(rename = "detection-ready")]
    DetectionReady { filename: String, count: usize },
}

#[derive(Clone)]
pub struct AppState {
    pub context: AppContext,
    pub photos_dir: PathBuf,
    pub event_tx: tokio::sync::broadcast::Sender<PhotoEvent>,
    pub pet_names: HashMap<String, String>,
    pub detect_client: Option<Arc<DetectClient>>,
    pub local_detector: Option<Arc<crate::detect::local::LocalDetector>>,
    pub backfill_running: Arc<AtomicBool>,
    pub night_assist_host: Option<String>,
    daily_summary_cache: Arc<Mutex<Option<summary::CachedSummary>>>,
}

/// Load pet display names from environment variables.
/// PET_NAME_MIKE=ミケ, PET_NAME_CHATORA=チャトラ, etc.
pub fn load_pet_names() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (key, value) in std::env::vars() {
        if let Some(pet_id) = key.strip_prefix("PET_NAME_") {
            map.insert(pet_id.to_ascii_lowercase(), value);
        }
    }
    map
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        context: AppContext,
        photos_dir: PathBuf,
        event_tx: tokio::sync::broadcast::Sender<PhotoEvent>,
        pet_names: HashMap<String, String>,
        detect_client: Option<Arc<DetectClient>>,
        local_detector: Option<Arc<crate::detect::local::LocalDetector>>,
        backfill_running: Arc<AtomicBool>,
        night_assist_host: Option<String>,
    ) -> Self {
        Self {
            context,
            photos_dir,
            event_tx,
            pet_names,
            detect_client,
            local_detector,
            backfill_running,
            night_assist_host,
            daily_summary_cache: Arc::new(Mutex::new(None)),
        }
    }

    fn queries(&self) -> EventQueries {
        self.context.event_queries()
    }

    fn commands(&self) -> ObservationCommands {
        self.context.observation_commands()
    }
}

pub fn router(state: AppState) -> Router {
    let mcp_state = crate::mcp::McpState {
        store: state.context.repository().clone(),
        photos_dir: state.photos_dir.clone(),
        base_url: state.context.base_url().map(str::to_string),
        is_tls: state.context.is_tls(),
    };

    let mcp_router = Router::new()
        .route("/mcp", post(crate::mcp::handle_mcp))
        .route(
            "/mcp/photos/{id}",
            get(crate::mcp::handle_mcp_photo_download),
        )
        .with_state(mcp_state);

    Router::new()
        .route("/app", get(assets::handle_embedded_app))
        .route("/app/{*path}", get(assets::handle_embedded_asset))
        .route("/api/photos", get(album::handle_photos_list))
        .route(
            "/api/photos/{filename}",
            get(album::handle_photo_serve).patch(album::handle_photo_update),
        )
        .route(
            "/api/photos/{filename}/panel/{panel}",
            get(album::handle_photo_panel),
        )
        .route("/api/photos/ingest", post(album::handle_ingest))
        .route("/api/event/{id}", get(album::handle_event_by_id))
        .route(
            "/api/detections/{id}",
            get(album::handle_detections_get).patch(album::handle_detection_update),
        )
        .route("/api/backfill", post(detection::handle_backfill))
        .route(
            "/api/backfill/status",
            get(detection::handle_backfill_status),
        )
        .route(
            "/api/detect-now/{filename}",
            post(detection::handle_detect_now),
        )
        .route("/api/edit-history", get(album::handle_edit_history))
        .route("/api/stats", get(album::handle_stats))
        .route("/api/behaviors", get(album::handle_behaviors))
        .route("/api/daily-summary", post(summary::handle_daily_summary))
        .route("/api/pet-names", get(album::handle_pet_names))
        .route("/api/events", get(events::handle_sse))
        .route(
            "/api/night-assist/detections/stream",
            get(events::handle_night_assist_sse),
        )
        .route("/health", get(handle_health))
        .route("/test/websr", get(test_pages::handle_websr_test))
        .route("/test/esrgan", get(test_pages::handle_esrgan_test))
        .route("/test/carousel", get(test_pages::handle_carousel_demo))
        .route("/test/carousel.js", get(test_pages::handle_carousel_js))
        .route("/test/models/{*path}", get(test_pages::handle_test_model))
        .route("/api/models/{*path}", get(test_pages::handle_test_model))
        .with_state(state)
        .merge(mcp_router)
}

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({"ok": true}))
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
    use crate::application::PhotoStoreRepository;
    use crate::db::PhotoStore;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use chrono::NaiveDate;
    use futures_util::StreamExt;
    use std::sync::atomic::Ordering;
    use tower::util::ServiceExt;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::DateTime<chrono::Utc> {
        crate::timestamps::from_camera_local(
            NaiveDate::from_ymd_opt(y, m, d)
                .unwrap()
                .and_hms_opt(h, mi, s)
                .unwrap(),
        )
    }

    fn test_state() -> AppState {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let (repository, _db) = PhotoStoreRepository::shared(store);
        let td = tempfile::tempdir().unwrap();
        let photos_dir = td.path().to_path_buf();
        std::mem::forget(td);
        let (event_tx, _) = tokio::sync::broadcast::channel(16);
        let context = AppContext::new(
            repository,
            photos_dir.clone(),
            tokio::sync::broadcast::channel(64).0,
            None,
            false,
            crate::vlm::VlmConfig::default(),
        );
        AppState::new(
            context,
            photos_dir,
            event_tx,
            HashMap::from([
                ("mike".into(), "Mike".into()),
                ("chatora".into(), "Chatora".into()),
            ]),
            None,
            None,
            Arc::new(AtomicBool::new(false)),
            None,
        )
    }

    #[tokio::test]
    async fn embedded_app_serves_index() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/app").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("<div id=\"app\"></div>"));
        assert!(html.contains("/app/main."));
    }

    #[tokio::test]
    async fn health_endpoint() {
        let app = router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn photos_list_empty_returns_events_shape() {
        let app = router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 0);
        assert!(json["events"].is_array());
        assert_eq!(json["events"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn photos_list_returns_frontend_event_contract() {
        let state = test_state();
        let commands = state.context.observation_commands();
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: Some("chatora".into()),
            })
            .await
            .unwrap();
        commands
            .apply_observation(crate::application::ObservationResult {
                source_filename: "a.jpg".into(),
                is_valid: true,
                summary: "tabby cat resting".into(),
                behavior: "resting".into(),
            })
            .await
            .unwrap();

        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos?is_valid=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 1);
        let event = &json["events"][0];
        assert_eq!(event["source_filename"], "a.jpg");
        assert_eq!(event["status"], "valid");
        assert_eq!(event["pet_id"], "chatora");
        assert_eq!(event["behavior"], "resting");
        assert_eq!(event["summary"], "tabby cat resting");
        // Served in the stored form: the UTC instant named by 10:00 local.
        assert_eq!(
            event["observed_at"],
            crate::timestamps::to_db(dt(2026, 3, 21, 10, 0, 0))
        );
    }

    #[tokio::test]
    async fn photo_serve_not_found() {
        let app = router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos/nonexistent.jpg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn photo_serve_path_traversal() {
        let app = router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/photos/../../../etc/passwd")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn stats_endpoint_returns_frontend_contract() {
        let state = test_state();
        let commands = state.context.observation_commands();
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: None,
            })
            .await
            .unwrap();

        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/stats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
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
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let mut stream = resp.into_body().into_data_stream();

        tx.send(PhotoEvent::Update {
            filename: "a.jpg".into(),
            is_valid: true,
            caption: "tabby cat resting".into(),
            behavior: "resting".into(),
            pet_id: Some("chatora".into()),
        })
        .unwrap();

        let chunk = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let text = String::from_utf8_lossy(&chunk);
        assert!(text.contains("event: event"));
        assert!(text.contains("\"filename\":\"a.jpg\""));
    }

    #[tokio::test]
    async fn ingest_creates_photo_and_detections() {
        let state = test_state();
        let app = router(state);
        let body = serde_json::json!({
            "filename": "comic_20260321_104532_chatora.jpg",
            "captured_at": "2026-03-21T10:45:32",
            "pet_id": "chatora",
            "detections": [
                {
                    "panel_index": 0,
                    "bbox_x": 50, "bbox_y": 30, "bbox_w": 120, "bbox_h": 180,
                    "yolo_class": "cat",
                    "pet_class": "chatora",
                    "confidence": 0.85,
                    "detected_at": "2026-03-21T10:45:32"
                },
                {
                    "panel_index": 0,
                    "bbox_x": 300, "bbox_y": 100, "bbox_w": 80, "bbox_h": 60,
                    "yolo_class": "cup",
                    "confidence": 0.62,
                    "detected_at": "2026-03-21T10:45:32"
                }
            ]
        });
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/photos/ingest")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["detections_count"], 2);
        assert!(json["photo_id"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn get_detections_returns_ingested_data() {
        let state = test_state();
        let commands = state.context.observation_commands();
        commands
            .ingest_with_detections(
                "test.jpg",
                dt(2026, 3, 21, 10, 0, 0),
                Some("mike"),
                &[crate::db::DetectionInput {
                    panel_index: Some(0),
                    bbox_x: 10,
                    bbox_y: 20,
                    bbox_w: 100,
                    bbox_h: 150,
                    yolo_class: Some("cat".into()),
                    pet_class: Some("mike".into()),
                    confidence: Some(0.9),
                    detected_at: "2026-03-21T10:00:00".into(),
                    color_metrics: None,
                    det_level: 1,
                    model: None,
                }],
            )
            .await
            .unwrap();

        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/detections/1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let dets = json.as_array().unwrap();
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0]["yolo_class"], "cat");
        assert_eq!(dets[0]["pet_class"], "mike");
        assert_eq!(dets[0]["bbox_x"], 10);
    }

    #[tokio::test]
    async fn patch_detection_override() {
        let state = test_state();
        let commands = state.context.observation_commands();
        commands
            .ingest_with_detections(
                "test.jpg",
                dt(2026, 3, 21, 10, 0, 0),
                Some("chatora"),
                &[crate::db::DetectionInput {
                    panel_index: Some(0),
                    bbox_x: 10,
                    bbox_y: 20,
                    bbox_w: 100,
                    bbox_h: 150,
                    yolo_class: Some("cat".into()),
                    pet_class: Some("chatora".into()),
                    confidence: Some(0.8),
                    detected_at: "2026-03-21T10:00:00".into(),
                    color_metrics: None,
                    det_level: 1,
                    model: None,
                }],
            )
            .await
            .unwrap();

        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/detections/1")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"pet_id_override":"mike"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["pet_id_override"], "mike");
    }

    #[tokio::test]
    async fn patch_detection_not_found() {
        let app = router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/detections/999")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"pet_id_override":"mike"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn pet_names_endpoint() {
        let state = test_state();
        // Insert photos so distinct_pet_ids returns results
        let commands = state.context.observation_commands();
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "b.jpg".into(),
                captured_at: dt(2026, 3, 21, 11, 0, 0),
                pet_id: Some("chatora".into()),
            })
            .await
            .unwrap();

        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/pet-names")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        // Display names from AppState.pet_names override
        assert_eq!(json["mike"], "Mike");
        assert_eq!(json["chatora"], "Chatora");
    }

    #[tokio::test]
    async fn event_by_id_returns_event_contract_and_not_found() {
        let state = test_state();
        let commands = state.context.observation_commands();
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "event-by-id.jpg".into(),
                captured_at: dt(2026, 4, 2, 8, 30, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        commands
            .apply_observation(crate::application::ObservationResult {
                source_filename: "event-by-id.jpg".into(),
                is_valid: true,
                summary: "Mike is watching the window".into(),
                behavior: "watching".into(),
            })
            .await
            .unwrap();

        let app = router(state);
        let found = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/event/1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(found.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(found.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["id"], 1);
        assert_eq!(json["source_filename"], "event-by-id.jpg");
        // Stored and served in UTC: 08:30 JST is 23:30 the previous day.
        assert_eq!(
            json["observed_at"],
            crate::timestamps::to_db(dt(2026, 4, 2, 8, 30, 0))
        );
        assert_eq!(json["summary"], "Mike is watching the window");
        assert_eq!(json["status"], "valid");
        assert_eq!(json["pet_id"], "mike");
        assert_eq!(json["behavior"], "watching");

        let missing = app
            .oneshot(
                Request::builder()
                    .uri("/api/event/999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(missing.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["error"], "not found");
    }

    #[tokio::test]
    async fn photo_panel_serves_640_square_jpeg_and_validates_panel_number() {
        let state = test_state();
        let filename = "comic_20260402_083000_mike.jpg";
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            848,
            496,
            image::Rgb([20, 80, 160]),
        ))
        .write_to(&mut encoded, image::ImageFormat::Jpeg)
        .unwrap();
        std::fs::write(state.photos_dir.join(filename), encoded.into_inner()).unwrap();

        let app = router(state);
        let ok = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/photos/{filename}/panel/2"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(
            ok.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let bytes = axum::body::to_bytes(ok.into_body(), usize::MAX)
            .await
            .unwrap();
        let panel = image::load_from_memory(&bytes).unwrap();
        assert_eq!((panel.width(), panel.height()), (640, 640));

        let invalid = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/photos/{filename}/panel/4"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn photo_patch_updates_all_editable_fields_and_rejects_empty_patch() {
        let state = test_state();
        state
            .context
            .observation_commands()
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "editable.jpg".into(),
                captured_at: dt(2026, 4, 2, 9, 0, 0),
                pet_id: None,
            })
            .await
            .unwrap();
        let app = router(state);

        let updated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/photos/editable.jpg")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"is_valid":true,"pet_id":"chatora","behavior":"playing"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(updated.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(json["ok"].as_bool().unwrap());
        assert!(json["is_valid"].as_bool().unwrap());
        assert_eq!(json["pet_id"], "chatora");
        assert_eq!(json["behavior"], "playing");

        let event = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/event/1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(event.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["status"], "valid");
        assert_eq!(json["pet_id"], "chatora");
        assert_eq!(json["behavior"], "playing");

        let empty = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/photos/editable.jpg")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);

        let missing = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/photos/missing.jpg")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"is_valid":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn edit_history_returns_patch_diffs_and_honors_since_filter() {
        let state = test_state();
        state
            .context
            .observation_commands()
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "history.jpg".into(),
                captured_at: dt(2026, 4, 2, 9, 15, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        let app = router(state);
        for body in [r#"{"pet_id":"chatora"}"#, r#"{"behavior":"sleeping"}"#] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PATCH")
                        .uri("/api/photos/history.jpg")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let history = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/edit-history")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(history.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(history.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let entries = json.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["photo_id"], 1);
        assert!(entries.iter().all(|entry| entry["id"].is_i64()));
        assert!(entries.iter().all(|entry| entry["created_at"].is_string()));
        let changes: Vec<serde_json::Value> = entries
            .iter()
            .map(|entry| serde_json::from_str(entry["changes"].as_str().unwrap()).unwrap())
            .collect();
        assert!(
            changes
                .iter()
                .any(|change| change["pet_id"]["old"] == "mike")
        );
        assert!(
            changes
                .iter()
                .any(|change| change["behavior"]["new"] == "sleeping")
        );

        let filtered = app
            .oneshot(
                Request::builder()
                    .uri("/api/edit-history?since=2999-01-01T00%3A00%3A00")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(filtered.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(filtered.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json, serde_json::json!([]));
    }

    #[tokio::test]
    async fn behaviors_returns_sorted_distinct_non_empty_values() {
        let state = test_state();
        let commands = state.context.observation_commands();
        for (filename, behavior) in [
            ("playing.jpg", "playing"),
            ("sleeping.jpg", "sleeping"),
            ("playing-again.jpg", "playing"),
        ] {
            commands
                .ingest_source_photo(crate::application::ObservationInput {
                    source_filename: filename.into(),
                    captured_at: dt(2026, 4, 2, 10, 0, 0),
                    pet_id: None,
                })
                .await
                .unwrap();
            commands.update_behavior(filename, behavior).await.unwrap();
        }
        commands
            .ingest_source_photo(crate::application::ObservationInput {
                source_filename: "empty.jpg".into(),
                captured_at: dt(2026, 4, 2, 11, 0, 0),
                pet_id: None,
            })
            .await
            .unwrap();

        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/behaviors")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json, serde_json::json!(["playing", "sleeping"]));
    }

    #[tokio::test]
    async fn backfill_reports_unavailable_and_conflict_contracts() {
        let unavailable = router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/backfill")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(unavailable.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["error"], "detection not configured");

        let mut state = test_state();
        state.detect_client = Some(Arc::new(crate::detect::DetectClient::new(
            crate::detect::DetectConfig {
                camera_base_url: "http://127.0.0.1:1".into(),
                self_base_url: "http://127.0.0.1:8082".into(),
                timeout: std::time::Duration::from_millis(1),
                score_threshold: 0.1,
            },
        )));
        state.backfill_running.store(true, Ordering::SeqCst);
        let conflict = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/backfill")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(conflict.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["error"], "backfill already running");
    }

    #[tokio::test]
    async fn detect_now_reports_local_detector_unavailable() {
        let response = router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/detect-now/comic.jpg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["error"], "local detector not available");
    }

    #[tokio::test]
    async fn daily_summary_without_observations_is_available_without_vlm() {
        let response = router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/daily-summary")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"date":"2026-04-02"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["date"], "2026-04-02");
        assert_eq!(json["summary"], "No observations for this date.");
        assert_eq!(json["photo_count"], 0);
    }

    #[tokio::test]
    async fn daily_summary_rejects_invalid_request_shape() {
        let response = router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/daily-summary")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"date":42}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn sse_preserves_detection_event_names_and_payloads() {
        let state = test_state();
        let tx = state.event_tx.clone();
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();

        tx.send(PhotoEvent::DetectionPartial {
            filename: "comic.jpg".into(),
            bbox_x: 10,
            bbox_y: 20,
            bbox_w: 30,
            bbox_h: 40,
            yolo_class: "cat".into(),
            confidence: 0.875,
        })
        .unwrap();
        let partial = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let partial = String::from_utf8_lossy(&partial);
        assert!(partial.contains("event: detection-partial"));
        assert!(partial.contains("\"type\":\"detection-partial\""));
        assert!(partial.contains("\"yolo_class\":\"cat\""));

        tx.send(PhotoEvent::DetectionReady {
            filename: "comic.jpg".into(),
            count: 3,
        })
        .unwrap();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ready = String::from_utf8_lossy(&ready);
        assert!(ready.contains("event: detection-ready"));
        assert!(ready.contains("\"type\":\"detection-ready\""));
        assert!(ready.contains("\"count\":3"));
    }
}
