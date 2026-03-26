use crate::application::{AppContext, EventQueries, EventSummary, ObservationCommands};
use crate::db::DetectionInput;
use crate::detect::DetectClient;
use crate::ingest::filename::parse_comic_filename;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::stream::Stream;
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

static EMBEDDED_UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/ui/dist");

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
        .route("/app", get(handle_embedded_app))
        .route("/app/{*path}", get(handle_embedded_asset))
        .route("/api/photos", get(handle_photos_list))
        .route(
            "/api/photos/{filename}",
            get(handle_photo_serve).patch(handle_photo_update),
        )
        .route(
            "/api/photos/{filename}/panel/{panel}",
            get(handle_photo_panel),
        )
        .route("/api/photos/ingest", post(handle_ingest))
        .route(
            "/api/detections/{id}",
            get(handle_detections_get).patch(handle_detection_update),
        )
        .route("/api/backfill", post(handle_backfill))
        .route("/api/backfill/status", get(handle_backfill_status))
        .route("/api/detect-now/{filename}", post(handle_detect_now))
        .route("/api/edit-history", get(handle_edit_history))
        .route("/api/stats", get(handle_stats))
        .route("/api/behaviors", get(handle_behaviors))
        .route("/api/daily-summary", post(handle_daily_summary))
        .route("/api/pet-names", get(handle_pet_names))
        .route("/api/events", get(handle_sse))
        .route("/health", get(handle_health))
        .route("/test/websr", get(handle_websr_test))
        .with_state(state)
        .merge(mcp_router)
}

#[derive(Deserialize)]
struct PhotosQuery {
    is_valid: Option<String>,
    pet_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<String>,
    behavior: Option<String>,
    yolo_class: Option<String>,
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
    let query = build_event_query(&q);
    match state.queries().list_events(query).await {
        Ok((events, total)) => Json(PhotosResponse { events, total }).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

async fn handle_photo_serve(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let path = state.photos_dir.join(&safe_name);

    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let stream = tokio_util::io::ReaderStream::new(file);
            let body = axum::body::Body::from_stream(stream);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                ],
                body,
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not found"})),
        )
            .into_response(),
    }
}

/// GET /api/photos/{filename}/panel/{panel} — serve a single panel (0-3) from a 2×2 comic image.
async fn handle_photo_panel(
    State(state): State<AppState>,
    Path((filename, panel)): Path<(String, u32)>,
) -> impl IntoResponse {
    if panel > 3 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "panel must be 0-3"})),
        )
            .into_response();
    }

    let safe_name = sanitize_filename(&filename);
    let path = state.photos_dir.join(&safe_name);

    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
                .into_response();
        }
    };

    // Decode, crop panel, re-encode as JPEG
    match crop_panel(&bytes, panel) {
        Ok(jpeg) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            jpeg,
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("crop failed: {e}")})),
        )
            .into_response(),
    }
}

/// Crop a 2×2 comic panel from a JPEG, stripping borders/margins,
/// and letterbox to 640×640 for YOLO input.
///
/// Comic layout (848×496): margin=12, border=2, gap=8, panel=404×228
/// Panel content starts at (margin+border, margin+border) = (14, 14)
///
/// Optimized: RGB (no alpha), SubImage view (no panel copy), replace (no blend).
fn crop_panel(jpeg_bytes: &[u8], panel: u32) -> Result<Vec<u8>, String> {
    const MARGIN: u32 = 12;
    const BORDER: u32 = 2;
    const GAP: u32 = 8;
    const PANEL_W: u32 = 404;
    const PANEL_H: u32 = 228;
    const CELL_W: u32 = PANEL_W + 2 * BORDER;
    const CELL_H: u32 = PANEL_H + 2 * BORDER;
    const TARGET: u32 = 640;

    // Decode to RGB (no alpha — JPEG has none)
    let rgb = image::load_from_memory_with_format(jpeg_bytes, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?
        .into_rgb8();

    let col = panel % 2;
    let row = panel / 2;
    let x = MARGIN + BORDER + col * (CELL_W + GAP);
    let y = MARGIN + BORDER + row * (CELL_H + GAP);

    // SubImage view — no pixel copy, just a window into rgb
    let panel_view = image::imageops::crop_imm(&rgb, x, y, PANEL_W, PANEL_H);

    // Letterbox: resize preserving aspect ratio, center on black 640×640 canvas
    let scale = (TARGET as f64 / PANEL_W as f64).min(TARGET as f64 / PANEL_H as f64);
    let new_w = (PANEL_W as f64 * scale) as u32;
    let new_h = (PANEL_H as f64 * scale) as u32;
    let resized = image::imageops::resize(
        &*panel_view,
        new_w,
        new_h,
        image::imageops::FilterType::Lanczos3,
    );

    let pad_x = (TARGET - new_w) / 2;
    let pad_y = (TARGET - new_h) / 2;
    let mut canvas = image::RgbImage::new(TARGET, TARGET); // black (zero-initialized)
    image::imageops::replace(&mut canvas, &resized, pad_x as i64, pad_y as i64);

    // Encode directly as RGB JPEG — pre-allocate ~50KB
    let mut buf = std::io::Cursor::new(Vec::with_capacity(50_000));
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

#[derive(Deserialize)]
struct PhotoUpdate {
    is_valid: Option<bool>,
    pet_id: Option<String>,
    behavior: Option<String>,
}

async fn handle_photo_update(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    Json(body): Json<PhotoUpdate>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let queries = state.queries();
    let commands = state.commands();

    match queries.get_event_by_source(&safe_name).await {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
        Ok(Some(_)) => {}
    }

    let mut updated = serde_json::json!({"ok": true});

    if let Some(is_valid) = body.is_valid {
        if let Err(e) = commands.override_event_validity(&safe_name, is_valid).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
        updated["is_valid"] = serde_json::json!(is_valid);
    }

    if let Some(ref pet_id) = body.pet_id {
        if let Err(e) = commands.update_pet_id(&safe_name, pet_id).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
        updated["pet_id"] = serde_json::json!(pet_id);
    }

    if let Some(ref behavior) = body.behavior {
        if let Err(e) = commands.update_behavior(&safe_name, behavior).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
        updated["behavior"] = serde_json::json!(behavior);
    }

    if body.is_valid.is_none() && body.pet_id.is_none() && body.behavior.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "is_valid, pet_id, or behavior required"})),
        )
            .into_response();
    }

    Json(updated).into_response()
}

fn deserialize_null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::deserialize(deserializer)?.unwrap_or_default())
}

// POST /api/photos/ingest — rdk-x5 sends comic metadata + detections
#[derive(Deserialize)]
struct IngestRequest {
    filename: String,
    captured_at: String,
    pet_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_as_default")]
    detections: Vec<DetectionInput>,
}

async fn handle_ingest(
    State(state): State<AppState>,
    Json(body): Json<IngestRequest>,
) -> impl IntoResponse {
    let captured_at =
        match chrono::NaiveDateTime::parse_from_str(&body.captured_at, "%Y-%m-%dT%H:%M:%S") {
            Ok(dt) => dt,
            Err(_) => match chrono::NaiveDateTime::parse_from_str(
                &body.captured_at,
                "%Y-%m-%dT%H:%M:%S%.f",
            ) {
                Ok(dt) => dt,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": format!("invalid captured_at: {e}")})),
                    )
                        .into_response();
                }
            },
        };

    let safe_name = sanitize_filename(&body.filename);
    let commands = state.commands();

    match commands
        .ingest_with_detections(
            &safe_name,
            captured_at,
            body.pet_id.as_deref(),
            &body.detections,
        )
        .await
    {
        Ok(photo_id) => Json(serde_json::json!({
            "ok": true,
            "photo_id": photo_id,
            "detections_count": body.detections.len(),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// GET /api/detections/:id — get detections for a photo
async fn handle_detections_get(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match state.queries().get_detections(id).await {
        Ok(dets) => Json(dets).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
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
    match state
        .commands()
        .update_detection_override(id, &body.pet_id_override)
        .await
    {
        Ok(0) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "detection not found"})),
        )
            .into_response(),
        Ok(_) => Json(serde_json::json!({"ok": true, "pet_id_override": body.pet_id_override}))
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// GET /api/edit-history — list edit history entries, optionally filtered by since
#[derive(Deserialize)]
struct EditHistoryQuery {
    since: Option<String>,
}

async fn handle_edit_history(
    State(state): State<AppState>,
    Query(query): Query<EditHistoryQuery>,
) -> impl IntoResponse {
    match state
        .context
        .event_queries()
        .get_edit_history(query.since.as_deref())
        .await
    {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// POST /api/backfill — trigger detection backfill for photos without detections
async fn handle_backfill(State(state): State<AppState>) -> impl IntoResponse {
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

async fn handle_backfill_status(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "running": state.backfill_running.load(Ordering::SeqCst)
    }))
}

/// POST /api/detect-now/{filename} — run Level2 detection with progressive SSE updates.
/// Each detection is streamed as a `detection-partial` SSE event as soon as found.
/// On completion, saves to DB and sends `detection-ready`.
async fn handle_detect_now(
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

async fn handle_stats(State(state): State<AppState>) -> impl IntoResponse {
    match state.queries().activity_stats().await {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

async fn handle_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(ref photo_event) => {
            let event_name = match photo_event {
                PhotoEvent::Update { .. } => "event",
                PhotoEvent::DetectionPartial { .. } => "detection-partial",
                PhotoEvent::DetectionReady { .. } => "detection-ready",
            };
            let json = serde_json::to_string(&photo_event).unwrap_or_default();
            Some(Ok(Event::default().event(event_name).data(json)))
        }
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn handle_pet_names(State(state): State<AppState>) -> impl IntoResponse {
    match state.queries().distinct_pet_ids().await {
        Ok(ids) => {
            let map: HashMap<String, String> = ids
                .into_iter()
                .map(|id| {
                    let display = state
                        .pet_names
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| id.clone());
                    (id, display)
                })
                .collect();
            Json(map).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

async fn handle_behaviors(State(state): State<AppState>) -> impl IntoResponse {
    match state.queries().distinct_behaviors().await {
        Ok(behaviors) => Json(behaviors).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct DailySummaryRequest {
    date: Option<String>,
}

#[derive(Serialize)]
struct DailySummaryResponse {
    date: String,
    summary: String,
    photo_count: usize,
}

async fn handle_daily_summary(
    State(state): State<AppState>,
    Json(body): Json<DailySummaryRequest>,
) -> impl IntoResponse {
    let date = body
        .date
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

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
    match vlm_client
        .summarize_day(&captions, random_photo.as_deref())
        .await
    {
        Ok(summary) => Json(DailySummaryResponse {
            date,
            summary,
            photo_count,
        })
        .into_response(),
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

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({"ok": true}))
}

fn build_event_query(q: &PhotosQuery) -> crate::application::EventQuery {
    use crate::application::EventStatusFilter;
    let is_pending = q.is_valid.as_deref() == Some("pending");
    crate::application::EventQuery {
        status: if is_pending {
            EventStatusFilter::Pending
        } else {
            match q.is_valid.as_deref() {
                Some("true") | Some("1") => EventStatusFilter::Valid,
                Some("false") | Some("0") => EventStatusFilter::Invalid,
                _ => EventStatusFilter::All,
            }
        },
        pet_id: q.pet_id.clone().filter(|s| !s.is_empty()),
        limit: q.limit,
        offset: q.offset,
        search: q.search.clone().filter(|s| !s.is_empty()),
        behavior: q.behavior.clone().filter(|s| !s.is_empty()),
        yolo_classes: q
            .yolo_class
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    }
}

fn sanitize_filename(name: &str) -> String {
    std::path::Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

async fn handle_websr_test(State(state): State<AppState>) -> impl IntoResponse {
    // Pick latest photo for demo
    let latest = state
        .queries()
        .list_events(crate::application::EventQuery {
            limit: Some(1),
            ..Default::default()
        })
        .await
        .ok()
        .and_then(|(events, _)| events.into_iter().next())
        .map(|e| e.source_filename)
        .unwrap_or_default();

    let html = format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebSR Upscale Test</title>
<style>
* {{ box-sizing: border-box; margin: 0; }}
body {{ font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 12px; }}
h1 {{ font-size: 18px; margin-bottom: 8px; }}
h2 {{ font-size: 14px; color: #8888aa; margin: 16px 0 6px; }}
.status {{ padding: 6px 12px; border-radius: 6px; background: #262640; margin-bottom: 12px; font-size: 13px; }}
.status.ok {{ border-left: 3px solid #4caf50; }}
.status.err {{ border-left: 3px solid #f44336; }}
.status.loading {{ border-left: 3px solid #ff9800; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; }}
.card {{ background: #262640; border-radius: 8px; overflow: hidden; }}
.card-label {{ padding: 6px 10px; font-size: 12px; color: #aaa; display: flex; justify-content: space-between; }}
.card-label .dim {{ font-size: 11px; color: #666; }}
.card img, .card canvas {{ display: block; }}
.card.fit .card-scroll canvas, .card.fit img {{ width: 100%; }}
.card.actual canvas {{ max-width: none; image-rendering: pixelated; }}
.card-scroll {{ overflow-x: auto; }}
.log-wrap {{ position: relative; margin-bottom: 12px; }}
.log {{ padding: 6px 10px; background: #1e1e3a; border-radius: 6px; font-size: 10px; font-family: monospace; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }}
.log-copy {{ position: absolute; top: 4px; right: 4px; background: #444; color: #ccc; border: none; border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; }}
.log-copy:active {{ background: #666; }}
.log .err {{ color: #f44336; }}
.log .info {{ color: #8888cc; }}
label {{ cursor: pointer; }}
.full {{ margin-bottom: 16px; }}
.full img {{ max-width: 100%; border-radius: 8px; }}
select {{ background: #333; color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; font-size: 13px; }}
</style>
</head>
<body>
<h1>WebSR Upscale Quality Test</h1>

<div style="margin-bottom:12px">
  <label>Photo: <select id="photoSelect"></select></label>
  <label style="margin-left:12px">Model: <select id="modelSelect">
    <option value="anime4k/cnn-2x-s">2x Small (14KB)</option>
    <option value="anime4k/cnn-2x-m">2x Medium (35KB)</option>
    <option value="anime4k/cnn-2x-l">2x Large (114KB)</option>
  </select></label>
  <label style="margin-left:12px"><input type="checkbox" id="actualSize"> Actual pixel size</label>
</div>

<div id="statusBox" class="status loading">Initializing...</div>
<div class="log-wrap"><div id="logBox" class="log"></div><button class="log-copy" onclick="navigator.clipboard.writeText(logBox.innerText).then(()=>this.textContent='Copied!').catch(()=>this.textContent='Failed');setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>

<script>
// Pre-module diagnostics (runs even if module fails)
const logBox = document.getElementById("logBox");
function addLog(msg, cls) {{
  const d = document.createElement("div");
  d.className = cls || "info";
  d.textContent = new Date().toISOString().slice(11,23) + " " + msg;
  logBox.appendChild(d);
  logBox.scrollTop = logBox.scrollHeight;
}}
window._addLog = addLog;
addLog("v19 (copyTexToBuffer)");
addLog("navigator.gpu: " + (navigator.gpu ? "available" : "UNAVAILABLE"));
addLog("User-Agent: " + navigator.userAgent.slice(0, 80));
window.addEventListener("error", (e) => addLog("JS Error: " + e.message + " @ " + e.filename + ":" + e.lineno, "err"));
window.addEventListener("unhandledrejection", (e) => addLog("Unhandled rejection: " + (e.reason?.message || e.reason), "err"));
</script>

<h2>Full Comic (Original)</h2>
<div class="full"><img id="fullImg" crossorigin="anonymous"></div>

<h2>Panel Comparison</h2>
<div id="panels"></div>

<script type="module">
const log = (...args) => {{ console.log("[websr-test]", ...args); window._addLog?.(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")); }};
const logErr = (...args) => {{ console.error("[websr-test]", ...args); window._addLog?.(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "), "err"); }};

let WebSR;
try {{
  WebSR = (await import("https://esm.sh/@websr/websr@0.0.15")).default;
}} catch (e) {{
  logErr("WebSR load failed: " + e.message);
  statusBox.textContent = "Failed: " + e.message; statusBox.className = "status err";
  throw e;
}}

const MARGIN = 12, BORDER = 2, GAP = 8, PW = 404, PH = 228;
const CELL_W = PW + 2 * BORDER, CELL_H = PH + 2 * BORDER;
const panelRegions = [0,1,2,3].map(i => {{
  const col = i % 2, row = Math.floor(i / 2);
  return {{
    x: MARGIN + BORDER + col * (CELL_W + GAP),
    y: MARGIN + BORDER + row * (CELL_H + GAP),
    w: PW, h: PH
  }};
}});

const statusBox = document.getElementById("statusBox");
const photoSelect = document.getElementById("photoSelect");
const modelSelect = document.getElementById("modelSelect");
const panelsDiv = document.getElementById("panels");
const fullImg = document.getElementById("fullImg");

// Fetch photo list
const resp = await fetch("/api/photos?limit=20");
const data = await resp.json();
data.events.forEach(e => {{
  const opt = document.createElement("option");
  opt.value = e.source_filename;
  opt.textContent = e.source_filename.replace("comic_","").replace(".jpg","");
  photoSelect.appendChild(opt);
}});
photoSelect.value = "{latest}";

let gpu = null;
try {{
  const result = await WebSR.initWebGPU();
  if (!result || result === false) throw new Error("not supported");
  gpu = result;
  const i = gpu.adapterInfo || {{}};
  statusBox.textContent = `WebGPU: ${{i.vendor||"?"}} ${{i.architecture||""}}`;
  statusBox.className = "status ok";
}} catch (e) {{
  statusBox.textContent = "WebGPU: " + e.message;
  statusBox.className = "status err";
}}

// Weight cache
const weightCache = {{}};
async function getWeights(model) {{
  if (weightCache[model]) return weightCache[model];
  const name = model.split("/")[1];
  const r = await fetch(`https://cdn.jsdelivr.net/npm/@websr/websr@0.0.15/weights/anime4k/${{name}}-rl.json`);
  if (!r.ok) throw new Error(`Weights ${{r.status}}`);
  const w = await r.json();
  weightCache[model] = w;
  return w;
}}

const workCanvas = document.createElement("canvas");
workCanvas.style.cssText = "position:fixed;top:-9999px;left:-9999px;pointer-events:none";
document.body.appendChild(workCanvas);
let renderCount = 0;

async function upscale(source, displayCanvas, model) {{
  const weights = await getWeights(model);
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const rid = ++renderCount;

  const websr = new WebSR({{ network_name: model, weights, gpu, canvas: workCanvas }});

  // Reconfigure canvas with COPY_SRC so we can read the output texture directly
  const gpuCtx = workCanvas.getContext("webgpu");
  gpuCtx.configure({{
    device: gpu,
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  }});

  const t0 = performance.now();
  await websr.render(source);

  // Get the texture that was just rendered to (same frame = same texture)
  const outTex = gpuCtx.getCurrentTexture();
  const outW = outTex.width;
  const outH = outTex.height;
  const bytesPerRow = Math.ceil(outW * 4 / 256) * 256;
  const readBuf = gpu.createBuffer({{
    size: bytesPerRow * outH,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  }});
  const enc = gpu.createCommandEncoder();
  enc.copyTextureToBuffer({{ texture: outTex }}, {{ buffer: readBuf, bytesPerRow }}, [outW, outH]);
  gpu.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(readBuf.getMappedRange());

  // Write to display canvas via ImageData (strip row alignment padding)
  const rowBytes = outW * 4;
  const pixels = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {{
    pixels.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }}
  readBuf.unmap();
  readBuf.destroy();

  displayCanvas.width = outW;
  displayCanvas.height = outH;
  displayCanvas.getContext("2d").putImageData(new ImageData(pixels, outW, outH), 0, 0);

  const ms = (performance.now() - t0).toFixed(0);
  const mid = ((outH / 2) * outW + outW / 2) * 4;
  const ok = pixels[mid] + pixels[mid+1] + pixels[mid+2] > 0;
  log(`R${{rid}} ${{w}}x${{h}}→${{outW}}x${{outH}} ${{ms}}ms px=[${{pixels[mid]}},${{pixels[mid+1]}},${{pixels[mid+2]}}] ${{ok ? "OK" : "BLACK"}}`);
}}

function cropPanel(img, idx) {{
  const r = panelRegions[idx];
  const c = document.createElement("canvas");
  c.width = r.w; c.height = r.h;
  c.getContext("2d").drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}}

async function run() {{
  const filename = photoSelect.value;
  if (!filename) return;

  fullImg.src = `/api/photos/${{encodeURIComponent(filename)}}`;
  await new Promise((resolve, reject) => {{
    fullImg.onload = resolve;
    fullImg.onerror = () => reject(new Error("img load failed"));
  }});

  panelsDiv.innerHTML = "";
  const model = modelSelect.value;

  const useActual = document.getElementById("actualSize").checked;
  const cardClass = useActual ? "card actual" : "card fit";

  // Build DOM structure and collect render targets
  const panels = [];
  for (let i = 0; i < 4; i++) {{
    const r = panelRegions[i];
    const row = document.createElement("div");
    row.innerHTML = `<h2>Panel ${{i}} (${{r.w}}x${{r.h}})</h2>`;
    const grid = document.createElement("div");
    grid.className = "grid";

    const origCanvas = cropPanel(fullImg, i);
    const card1 = document.createElement("div");
    card1.className = cardClass;
    card1.innerHTML = `<div class="card-label">Original<span class="dim">${{r.w}}x${{r.h}}</span></div><div class="card-scroll"></div>`;
    card1.querySelector(".card-scroll").appendChild(origCanvas);
    grid.appendChild(card1);

    const canvas2x = document.createElement("canvas");
    const card2 = document.createElement("div");
    card2.className = cardClass;
    card2.innerHTML = `<div class="card-label">WebSR 2x<span class="dim" id="dim2x-${{i}}">queued</span></div><div class="card-scroll"></div>`;
    card2.querySelector(".card-scroll").appendChild(canvas2x);
    grid.appendChild(card2);

    const canvas4x = document.createElement("canvas");
    const card3 = document.createElement("div");
    card3.className = cardClass;
    card3.innerHTML = `<div class="card-label">WebSR 4x (2-pass)<span class="dim" id="dim4x-${{i}}">queued</span></div><div class="card-scroll"></div>`;
    card3.querySelector(".card-scroll").appendChild(canvas4x);
    grid.appendChild(card3);

    row.appendChild(grid);
    panelsDiv.appendChild(row);
    panels.push({{ origCanvas, canvas2x, canvas4x }});
  }}

  if (!gpu) return;

  try {{
    // Batch 1: all 2x renders (same input resolution = same WebSR instance)
    statusBox.textContent = "Upscaling all panels (2x)...";
    statusBox.className = "status loading";
    for (let i = 0; i < 4; i++) {{
      const t0 = performance.now();
      const bmp = await createImageBitmap(panels[i].origCanvas);
      await upscale(bmp, panels[i].canvas2x, model);
      bmp.close();
      const ms = (performance.now() - t0).toFixed(0);
      document.getElementById(`dim2x-${{i}}`).textContent =
        `${{panels[i].canvas2x.width}}x${{panels[i].canvas2x.height}} (${{ms}}ms)`;
    }}

    // Batch 2: all 4x renders (feed 2x results, same resolution)
    statusBox.textContent = "Upscaling all panels (4x)...";
    for (let i = 0; i < 4; i++) {{
      document.getElementById(`dim4x-${{i}}`).textContent = "processing...";
      const t0 = performance.now();
      const bmp = await createImageBitmap(panels[i].canvas2x);
      await upscale(bmp, panels[i].canvas4x, model);
      bmp.close();
      const ms = (performance.now() - t0).toFixed(0);
      document.getElementById(`dim4x-${{i}}`).textContent =
        `${{panels[i].canvas4x.width}}x${{panels[i].canvas4x.height}} (${{ms}}ms)`;
    }}
  }} catch (e) {{
    logErr("Upscale failed:", e);
    statusBox.textContent = "Error: " + e.message;
    statusBox.className = "status err";
    return;
  }}

  statusBox.textContent = "Done";
  statusBox.className = "status ok";
}}

photoSelect.addEventListener("change", run);
modelSelect.addEventListener("change", run);
document.getElementById("actualSize").addEventListener("change", run);
run();
</script>
</body>
</html>"##
    );

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::PhotoStoreRepository;
    use crate::db::PhotoStore;
    use axum::body::Body;
    use axum::http::Request;
    use chrono::NaiveDate;
    use futures_util::StreamExt;
    use tower::util::ServiceExt;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, s)
            .unwrap()
    }

    fn test_state() -> AppState {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let repository = PhotoStoreRepository::shared(store);
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
        AppState {
            context,
            photos_dir,
            event_tx,
            pet_names: HashMap::from([
                ("mike".into(), "Mike".into()),
                ("chatora".into(), "Chatora".into()),
            ]),
            detect_client: None,
            local_detector: None,
            backfill_running: Arc::new(AtomicBool::new(false)),
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
        assert!(
            event["observed_at"]
                .as_str()
                .unwrap()
                .starts_with("2026-03-21T10:00:00")
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
}
