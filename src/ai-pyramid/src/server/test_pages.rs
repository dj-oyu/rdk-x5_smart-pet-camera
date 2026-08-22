use super::AppState;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

async fn latest_filename(state: &AppState) -> String {
    state
        .queries()
        .list_events(crate::application::EventQuery {
            limit: Some(1),
            ..Default::default()
        })
        .await
        .ok()
        .and_then(|(events, _)| events.into_iter().next())
        .map(|e| e.source_filename)
        .unwrap_or_default()
}

pub(super) async fn handle_websr_test(State(state): State<AppState>) -> impl IntoResponse {
    let latest = latest_filename(&state).await;
    let html = include_str!("../../static/websr.html").replace("__LATEST__", &latest);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}

pub(super) async fn handle_test_model(Path(path): Path<String>) -> impl IntoResponse {
    let safe_path = path.trim_start_matches('/').replace("..", "");
    let file_path = std::path::Path::new("/data/esrgan-models").join(&safe_path);
    match tokio::fs::read(&file_path).await {
        Ok(data) => {
            let mime = if safe_path.ends_with(".json") {
                "application/json"
            } else {
                "application/octet-stream"
            };
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, mime.to_string()),
                    (
                        header::CACHE_CONTROL,
                        "public, max-age=31536000, immutable".to_string(),
                    ),
                ],
                data,
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            format!("model not found: {safe_path}"),
        )
            .into_response(),
    }
}

pub(super) async fn handle_carousel_demo(State(state): State<AppState>) -> impl IntoResponse {
    let latest = latest_filename(&state).await;
    let html = include_str!("../../static/carousel.html").replace("__LATEST__", &latest);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}

pub(super) async fn handle_carousel_js() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../../static/carousel.js"),
    )
}

pub(super) async fn handle_esrgan_test(State(state): State<AppState>) -> impl IntoResponse {
    let latest = latest_filename(&state).await;
    let html = include_str!("../../static/esrgan.html").replace("__LATEST__", &latest);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}
