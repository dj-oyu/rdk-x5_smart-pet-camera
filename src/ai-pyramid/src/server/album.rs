use super::{AppState, sanitize_filename};
use crate::application::EventSummary;
use crate::db::DetectionInput;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub(super) struct PhotosQuery {
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

// --- REST API ---

pub(super) async fn handle_photos_list(
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

/// GET /api/event/{id} — single event by DB primary key (for deep links)
pub(super) async fn handle_event_by_id(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match state.queries().get_event_by_id(id).await {
        Ok(Some(ev)) => Json(serde_json::json!(ev)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub(super) async fn handle_photo_serve(
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
pub(super) async fn handle_photo_panel(
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
pub(super) struct PhotoUpdate {
    is_valid: Option<bool>,
    pet_id: Option<String>,
    behavior: Option<String>,
}

pub(super) async fn handle_photo_update(
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
pub(super) struct IngestRequest {
    filename: String,
    captured_at: String,
    pet_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_as_default")]
    detections: Vec<DetectionInput>,
}

pub(super) async fn handle_ingest(
    State(state): State<AppState>,
    Json(body): Json<IngestRequest>,
) -> impl IntoResponse {
    // Callers send either a stored-format UTC value or a bare local one; both
    // land on the same instant through `timestamps::parse_db`.
    let captured_at = match crate::timestamps::parse_db(&body.captured_at).or_else(|| {
        chrono::NaiveDateTime::parse_from_str(&body.captured_at, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .map(crate::timestamps::from_camera_local)
    }) {
        Some(instant) => instant,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("invalid captured_at: {}", body.captured_at)
                })),
            )
                .into_response();
        }
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
pub(super) async fn handle_detections_get(
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
pub(super) struct DetectionUpdate {
    pet_id_override: String,
}

pub(super) async fn handle_detection_update(
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
pub(super) struct EditHistoryQuery {
    since: Option<String>,
}

pub(super) async fn handle_edit_history(
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

pub(super) async fn handle_stats(State(state): State<AppState>) -> impl IntoResponse {
    match state.queries().activity_stats().await {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub(super) async fn handle_pet_names(State(state): State<AppState>) -> impl IntoResponse {
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

pub(super) async fn handle_behaviors(State(state): State<AppState>) -> impl IntoResponse {
    match state.queries().distinct_behaviors().await {
        Ok(behaviors) => Json(behaviors).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
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
