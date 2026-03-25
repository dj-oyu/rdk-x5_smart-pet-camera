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
pub struct PhotoEvent {
    pub filename: String,
    pub is_valid: bool,
    pub caption: String,
    pub behavior: String,
    pub pet_id: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub context: AppContext,
    pub photos_dir: PathBuf,
    pub event_tx: tokio::sync::broadcast::Sender<PhotoEvent>,
    pub pet_names: HashMap<String, String>,
    pub detect_client: Option<Arc<DetectClient>>,
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
        .route("/api/edit-history", get(handle_edit_history))
        .route("/api/stats", get(handle_stats))
        .route("/api/behaviors", get(handle_behaviors))
        .route("/api/daily-summary", post(handle_daily_summary))
        .route("/api/pet-names", get(handle_pet_names))
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
    let detect_client = match &state.detect_client {
        Some(c) => c.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "detection not configured (set PET_CAMERA_HOST or PET_ALBUM_HOST)"})),
            )
                .into_response();
        }
    };

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

        tracing::info!("Backfill: {} photos to process", photos.len());
        let mut ok = 0u32;
        let mut fail = 0u32;

        for photo in &photos {
            // Skip invalid photos — no point detecting on rejected images
            if photo.status == crate::application::EventStatus::Invalid {
                if let Err(e) = commands.mark_detected(photo.id).await {
                    tracing::warn!(
                        "Backfill mark_detected error {}: {e}",
                        photo.source_filename
                    );
                }
                continue;
            }
            match detect_client.detect(&photo.source_filename).await {
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
                            "Backfill OK: {} ({} dets)",
                            photo.source_filename,
                            dets.len()
                        );
                        ok += 1;
                    }
                }
                Ok(_) => {
                    // Zero detections — still mark as detected so we don't retry
                    tracing::info!("Backfill: no detections for {}", photo.source_filename);
                    if let Err(e) = commands.mark_detected(photo.id).await {
                        tracing::warn!(
                            "Backfill mark_detected error {}: {e}",
                            photo.source_filename
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Backfill detect error {}: {e}", photo.source_filename);
                    fail += 1;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        tracing::info!(
            "Backfill complete: {ok} ok, {fail} failed, {} total",
            photos.len()
        );
        backfill_flag.store(false, Ordering::SeqCst);
    });

    Json(serde_json::json!({"ok": true, "message": "backfill started"})).into_response()
}

async fn handle_backfill_status(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "running": state.backfill_running.load(Ordering::SeqCst)
    }))
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
        Ok(photo_event) => {
            let json = serde_json::to_string(&photo_event).unwrap_or_default();
            Some(Ok(Event::default().event("event").data(json)))
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

        tx.send(PhotoEvent {
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
