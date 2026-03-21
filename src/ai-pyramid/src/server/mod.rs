use crate::db::{PhotoFilter, PhotoStore};
use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<PhotoStore>>,
    pub photos_dir: PathBuf,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/album", get(handle_album_page))
        .route("/api/photos", get(handle_photos_list))
        .route("/api/photos/{filename}", get(handle_photo_serve).patch(handle_photo_update))
        .route("/api/stats", get(handle_stats))
        .route("/health", get(handle_health))
        .with_state(state)
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
    photos: Vec<PhotoJson>,
    total: i64,
}

#[derive(Serialize, Clone)]
struct PhotoJson {
    id: i64,
    filename: String,
    captured_at: String,
    caption: Option<String>,
    is_valid: Option<bool>,
    pet_id: Option<String>,
    behavior: Option<String>,
}

impl PhotoJson {
    fn caption_display(&self) -> &str {
        self.caption.as_deref().unwrap_or("")
    }
    fn pet_id_display(&self) -> &str {
        self.pet_id.as_deref().unwrap_or("")
    }
    fn behavior_display(&self) -> &str {
        self.behavior.as_deref().unwrap_or("")
    }
    fn status_class(&self) -> &str {
        match self.is_valid {
            Some(true) => "valid",
            Some(false) => "invalid",
            None => "pending",
        }
    }
    fn status_label(&self) -> &str {
        match self.is_valid {
            Some(true) => "valid",
            Some(false) => "filtered",
            None => "pending",
        }
    }
}

impl From<crate::db::Photo> for PhotoJson {
    fn from(p: crate::db::Photo) -> Self {
        Self {
            id: p.id,
            filename: p.filename,
            captured_at: p.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
            caption: p.caption,
            is_valid: p.is_valid,
            pet_id: p.pet_id,
            behavior: p.behavior,
        }
    }
}

// --- Album HTML page ---

#[derive(Template)]
#[template(path = "album.html")]
struct AlbumTemplate {
    photos: Vec<PhotoJson>,
    total: i64,
    filter_valid: String,
    filter_pet_id: String,
}

async fn handle_album_page(
    State(state): State<AppState>,
    Query(q): Query<PhotosQuery>,
) -> impl IntoResponse {
    let filter = build_filter(&q);
    let filter_valid = q.is_valid.unwrap_or_default();
    let filter_pet_id = q.pet_id.unwrap_or_default();

    // Initial page: newest 20, reversed so oldest is first (left→right = old→new)
    let page_filter = PhotoFilter {
        limit: Some(20),
        ..filter
    };
    let store = state.store.lock().unwrap();
    let (photos, total) = store.list(&page_filter).unwrap_or_default();
    drop(store);

    let mut photos: Vec<PhotoJson> = photos.into_iter().map(PhotoJson::from).collect();
    photos.reverse(); // oldest first → left=old, right=new

    let template = AlbumTemplate {
        photos,
        total,
        filter_valid,
        filter_pet_id,
    };
    Html(template.render().unwrap_or_else(|e| format!("Template error: {e}")))
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
                photos: photos.into_iter().map(PhotoJson::from).collect(),
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
}

async fn handle_photo_update(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    Json(body): Json<PhotoUpdate>,
) -> impl IntoResponse {
    let safe_name = sanitize_filename(&filename);
    let store = state.store.lock().unwrap();

    if let Some(is_valid) = body.is_valid {
        // Toggle is_valid (user override)
        let result = store.get_by_filename(&safe_name);
        match result {
            Ok(Some(photo)) => {
                let caption = photo.caption.as_deref().unwrap_or("");
                let behavior = photo.behavior.as_deref().unwrap_or("other");
                if let Err(e) = store.update_vlm_result(&safe_name, is_valid, caption, behavior) {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
                }
                Json(serde_json::json!({"ok": true, "is_valid": is_valid})).into_response()
            }
            Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        }
    } else {
        (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "is_valid required"}))).into_response()
    }
}

async fn handle_stats(State(state): State<AppState>) -> impl IntoResponse {
    let store = state.store.lock().unwrap();
    match store.stats() {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
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
        AppState {
            store: Arc::new(Mutex::new(store)),
            photos_dir,
        }
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
    async fn photos_list_empty() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/api/photos").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 0);
    }

    #[tokio::test]
    async fn photos_list_with_data() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
            store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), Some("mike")).unwrap();
            store.update_vlm_result("a.jpg", true, "cap", "resting").unwrap();
        }
        let app = router(state);
        let resp = app
            .oneshot(Request::builder().uri("/api/photos?is_valid=true").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 1);
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
    async fn stats_endpoint() {
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 1);
        assert_eq!(json["pending"], 1);
    }

    #[tokio::test]
    async fn album_page_renders() {
        let app = router(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/album").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("Pet Album"));
    }
}
