use crate::application::{AppContext, EventQuery, EventStatusFilter};
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    method: String,
    id: Option<Value>,
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i64, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError { code, message }),
        }
    }
}

pub async fn handle_mcp(
    State(state): State<AppContext>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    if req.id.is_none() || req.id.as_ref() == Some(&Value::Null) {
        return StatusCode::ACCEPTED.into_response();
    }

    let id = req.id.unwrap_or(Value::Null);
    let base_url = resolve_base_url(&state, &headers, &uri);

    let response = match req.method.as_str() {
        "initialize" => handle_initialize(id),
        "tools/list" => handle_tools_list(id),
        "tools/call" => handle_tools_call(state, id, req.params, base_url).await,
        _ => JsonRpcResponse::error(id, -32601, format!("Method not found: {}", req.method)),
    };

    Json(response).into_response()
}

fn resolve_base_url(state: &AppContext, headers: &HeaderMap, uri: &axum::http::Uri) -> Option<String> {
    if let Some(base_url) = state.base_url() {
        return Some(base_url.to_string());
    }

    let host = uri
        .authority()
        .map(|authority| authority.as_str().to_string())
        .or_else(|| headers.get(header::HOST).and_then(|value| value.to_str().ok()).map(String::from))
        .or_else(|| headers.get("x-forwarded-host").and_then(|value| value.to_str().ok()).map(String::from))?;

    let scheme = uri
        .scheme_str()
        .or_else(|| headers.get("x-forwarded-proto").and_then(|value| value.to_str().ok()))
        .unwrap_or(if state.is_tls() { "https" } else { "http" });

    Some(format!("{scheme}://{host}"))
}

fn handle_initialize(id: Value) -> JsonRpcResponse {
    JsonRpcResponse::success(
        id,
        json!({
            "protocolVersion": "2025-03-26",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "pet-album-mcp",
                "version": "0.1.0"
            }
        }),
    )
}

fn handle_tools_list(id: Value) -> JsonRpcResponse {
    JsonRpcResponse::success(
        id,
        json!({
            "tools": [
                {
                    "name": "get_recent_photos",
                    "description": "Get recent pet photo metadata (caption, timestamp, pet_id, behavior). Returns newest photos first. Each entry includes a download URL for the photo image.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "limit": {
                                "type": "integer",
                                "description": "Number of photos to return (default 20, max 50)",
                                "default": 20
                            },
                            "pet_id": {
                                "type": "string",
                                "description": "Filter by pet: \"chatora\", \"mike\"",
                                "enum": ["chatora", "mike"]
                            },
                            "status": {
                                "type": "string",
                                "description": "Optional status filter. Defaults to all statuses.",
                                "enum": ["all", "valid", "pending", "invalid"],
                                "default": "all"
                            }
                        }
                    }
                }
            ]
        }),
    )
}

async fn handle_tools_call(
    state: AppContext,
    id: Value,
    params: Option<Value>,
    base_url: Option<String>,
) -> JsonRpcResponse {
    let params = params.unwrap_or_else(|| json!({}));
    let tool_name = params.get("name").and_then(|value| value.as_str()).unwrap_or("");

    match tool_name {
        "get_recent_photos" => call_get_recent_photos(state, id, &params, base_url).await,
        _ => JsonRpcResponse::error(id, -32602, format!("Unknown tool: {tool_name}")),
    }
}

async fn call_get_recent_photos(
    state: AppContext,
    id: Value,
    params: &Value,
    base_url: Option<String>,
) -> JsonRpcResponse {
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);
    let limit = args.get("limit").and_then(|value| value.as_i64()).unwrap_or(20).clamp(1, 50);
    let pet_id = args.get("pet_id").and_then(|value| value.as_str()).map(String::from);
    let status = match args.get("status").and_then(|value| value.as_str()) {
        Some("valid") => EventStatusFilter::Valid,
        Some("pending") => EventStatusFilter::Pending,
        Some("invalid") => EventStatusFilter::Invalid,
        Some("all") | None => EventStatusFilter::All,
        Some(_) => {
            return JsonRpcResponse::error(id, -32602, "Invalid status: expected one of all, valid, pending, invalid".to_string())
        }
    };

    let query = EventQuery {
        status,
        pet_id: pet_id.filter(|value| !value.is_empty()),
        limit: Some(limit),
        offset: None,
    };

    match state.event_queries().list_events(query).await {
        Ok((events, total)) => {
            let mut lines = vec![format!("{} photos (total {total}):", events.len())];
            for event in &events {
                let caption = event.summary.as_deref().unwrap_or("");
                let pet = event.pet_id.as_deref().unwrap_or("?");
                let behavior = event.behavior.as_deref().unwrap_or("?");
                let ts = event.observed_at.replace('T', " ");
                let url = match &base_url {
                    Some(base) => format!("{}/mcp/photos/{}", base.trim_end_matches('/'), event.id),
                    None => format!("/mcp/photos/{}", event.id),
                };
                lines.push(format!(
                    "#{} | {} | {} | {} | \"{}\" | {}",
                    event.id, ts, pet, behavior, caption, url
                ));
            }
            JsonRpcResponse::success(
                id,
                json!({
                    "content": [{"type": "text", "text": lines.join("\n")}]
                }),
            )
        }
        Err(error) => JsonRpcResponse::error(id, -32603, format!("DB error: {error}")),
    }
}

pub async fn handle_mcp_photo_download(
    State(state): State<AppContext>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let filename = match state.event_queries().get_event_by_id(id).await {
        Ok(Some(event)) => event.source_filename,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": error})),
            )
                .into_response();
        }
    };

    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = state.photos_dir().join(&safe_name);

    if !path.exists() {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "file not found"}))).into_response();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{ObservationInput, ObservationResult, PhotoStoreRepository};
    use crate::db::PhotoStore;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post};
    use axum::Router;
    use chrono::NaiveDate;
    use std::path::PathBuf;
    use tokio::sync::broadcast;
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
        let repository = PhotoStoreRepository::shared(store);
        let tempdir = tempfile::tempdir().unwrap();
        let photos_dir = tempdir.path().to_path_buf();
        std::mem::forget(tempdir);
        let (event_tx, _) = broadcast::channel(16);
        AppContext::new(repository, photos_dir, event_tx, None, false)
    }

    fn test_router(state: AppContext) -> Router {
        Router::new()
            .route("/mcp", post(handle_mcp))
            .route("/mcp/photos/{id}", get(handle_mcp_photo_download))
            .with_state(state)
    }

    async fn post_jsonrpc(app: Router, body: Value) -> serde_json::Value {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn seed_valid_event(state: &AppContext, filename: &str, pet_id: &str, summary: &str, behavior: &str) {
        state
            .observation_commands()
            .ingest_source_photo(ObservationInput {
                source_filename: filename.into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: Some(pet_id.into()),
            })
            .await
            .unwrap();
        state
            .observation_commands()
            .apply_observation(ObservationResult {
                source_filename: filename.into(),
                is_valid: true,
                summary: summary.into(),
                behavior: behavior.into(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mcp_initialize() {
        let app = test_router(test_state());
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "initialize",
                "id": 1,
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1.0"}
                }
            }),
        )
        .await;
        assert_eq!(response["result"]["serverInfo"]["name"], "pet-album-mcp");
        assert_eq!(response["id"], 1);
    }

    #[tokio::test]
    async fn mcp_notification_returns_202() {
        let app = test_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "jsonrpc": "2.0",
                            "method": "notifications/initialized"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn mcp_tools_list() {
        let app = test_router(test_state());
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": 2
            }),
        )
        .await;
        let tools = response["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "get_recent_photos");
    }

    #[tokio::test]
    async fn mcp_get_recent_photos() {
        let state = test_state();
        seed_valid_event(&state, "a.jpg", "chatora", "Chatora resting", "resting").await;
        seed_valid_event(&state, "b.jpg", "mike", "Mike playing", "playing").await;

        let app = test_router(state);
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 3,
                "params": {
                    "name": "get_recent_photos",
                    "arguments": {"limit": 5}
                }
            }),
        )
        .await;
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("2 photos"));
        assert!(text.contains("chatora"));
        assert!(text.contains("mike"));
        assert!(text.contains("Chatora resting"));
        assert!(text.contains("/mcp/photos/"));
    }

    #[tokio::test]
    async fn mcp_get_recent_photos_defaults_to_all_statuses() {
        let state = test_state();
        state
            .observation_commands()
            .ingest_source_photo(ObservationInput {
                source_filename: "pending.jpg".into(),
                captured_at: dt(2026, 3, 21, 9, 0, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        seed_valid_event(&state, "valid.jpg", "chatora", "cap a", "resting").await;

        let app = test_router(state);
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 30,
                "params": {
                    "name": "get_recent_photos",
                    "arguments": {"limit": 10}
                }
            }),
        )
        .await;
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("2 photos"));
        assert!(text.contains("mike"));
        assert!(text.contains("cap a"));
    }

    #[tokio::test]
    async fn mcp_get_recent_photos_filter_valid_status() {
        let state = test_state();
        state
            .observation_commands()
            .ingest_source_photo(ObservationInput {
                source_filename: "pending.jpg".into(),
                captured_at: dt(2026, 3, 21, 9, 0, 0),
                pet_id: Some("mike".into()),
            })
            .await
            .unwrap();
        seed_valid_event(&state, "valid.jpg", "chatora", "cap a", "resting").await;

        let app = test_router(state);
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 31,
                "params": {
                    "name": "get_recent_photos",
                    "arguments": {"limit": 10, "status": "valid"}
                }
            }),
        )
        .await;
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("1 photos"));
        assert!(!text.contains("mike"));
        assert!(text.contains("cap a"));
    }

    #[tokio::test]
    async fn mcp_get_recent_photos_filter_pet() {
        let state = test_state();
        seed_valid_event(&state, "a.jpg", "chatora", "cap a", "resting").await;
        seed_valid_event(&state, "b.jpg", "mike", "cap b", "playing").await;

        let app = test_router(state);
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 4,
                "params": {
                    "name": "get_recent_photos",
                    "arguments": {"pet_id": "chatora"}
                }
            }),
        )
        .await;
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("1 photos"));
        assert!(text.contains("chatora"));
        assert!(!text.contains("mike"));
    }

    #[tokio::test]
    async fn mcp_photo_download() {
        let state = test_state();
        let photo_data = b"fake jpeg data";
        std::fs::write(state.photos_dir().join("a.jpg"), photo_data).unwrap();
        state
            .observation_commands()
            .ingest_source_photo(ObservationInput {
                source_filename: "a.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: Some("chatora".into()),
            })
            .await
            .unwrap();

        let app = test_router(state);
        let response = app
            .oneshot(Request::builder().uri("/mcp/photos/1").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], photo_data);
    }

    #[tokio::test]
    async fn mcp_photo_download_not_found() {
        let app = test_router(test_state());
        let response = app
            .oneshot(Request::builder().uri("/mcp/photos/999").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mcp_unknown_method() {
        let app = test_router(test_state());
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "unknown/method",
                "id": 99
            }),
        )
        .await;
        assert!(response["error"]["message"].as_str().unwrap().contains("Method not found"));
    }

    #[tokio::test]
    async fn mcp_unknown_tool() {
        let app = test_router(test_state());
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 10,
                "params": {"name": "nonexistent_tool", "arguments": {}}
            }),
        )
        .await;
        assert!(response["error"]["message"].as_str().unwrap().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn mcp_photos_url_from_host_header() {
        let state = test_state();
        seed_valid_event(&state, "a.jpg", "chatora", "cap", "resting").await;

        let app = test_router(state);
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "id": 1,
            "params": {"name": "get_recent_photos", "arguments": {"limit": 1}}
        }))
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("content-type", "application/json")
                    .header("host", "example.com:8082")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("http://example.com:8082/mcp/photos/"));
    }

    #[tokio::test]
    async fn mcp_prefers_public_url() {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let repository = PhotoStoreRepository::shared(store);
        let tempdir = tempfile::tempdir().unwrap();
        let photos_dir = PathBuf::from(tempdir.path());
        std::mem::forget(tempdir);
        let (event_tx, _) = broadcast::channel(16);
        let state = AppContext::new(
            repository,
            photos_dir,
            event_tx,
            Some("https://pets.example.com".into()),
            true,
        );
        seed_valid_event(&state, "a.jpg", "chatora", "cap", "resting").await;

        let app = test_router(state);
        let response = post_jsonrpc(
            app,
            json!({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 11,
                "params": {"name": "get_recent_photos", "arguments": {"limit": 1}}
            }),
        )
        .await;
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("https://pets.example.com/mcp/photos/"));
    }
}
