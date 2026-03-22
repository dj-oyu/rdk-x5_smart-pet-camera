use crate::db::{PhotoFilter, PhotoStore};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct McpState {
    pub store: Arc<Mutex<PhotoStore>>,
    pub photos_dir: PathBuf,
    pub base_url: Option<String>,
    pub is_tls: bool,
}

// --- JSON-RPC types ---

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
        Self { jsonrpc: "2.0", id, result: Some(result), error: None }
    }

    fn error(id: Value, code: i64, message: String) -> Self {
        Self { jsonrpc: "2.0", id, result: None, error: Some(JsonRpcError { code, message }) }
    }
}

// --- MCP protocol handler ---

pub async fn handle_mcp(
    State(state): State<McpState>,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    // Notifications (no id) get 202 Accepted
    if req.id.is_none() || req.id.as_ref() == Some(&Value::Null) {
        return StatusCode::ACCEPTED.into_response();
    }

    let id = req.id.unwrap();
    let base_url = resolve_base_url(&state, &headers);

    let resp = match req.method.as_str() {
        "initialize" => handle_initialize(id),
        "tools/list" => handle_tools_list(id),
        "tools/call" => handle_tools_call(state, id, req.params, base_url),
        _ => JsonRpcResponse::error(id, -32601, format!("Method not found: {}", req.method)),
    };

    Json(resp).into_response()
}

/// Resolve base URL: PUBLIC_URL env > Host header > relative path fallback
fn resolve_base_url(state: &McpState, headers: &HeaderMap) -> Option<String> {
    if state.base_url.is_some() {
        return state.base_url.clone();
    }
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())?;
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if state.is_tls { "https" } else { "http" });
    Some(format!("{scheme}://{host}"))
}

fn handle_initialize(id: Value) -> JsonRpcResponse {
    JsonRpcResponse::success(id, json!({
        "protocolVersion": "2025-03-26",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "pet-album-mcp",
            "version": "0.1.0"
        }
    }))
}

fn handle_tools_list(id: Value) -> JsonRpcResponse {
    JsonRpcResponse::success(id, json!({
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
                        }
                    }
                }
            }
        ]
    }))
}

fn handle_tools_call(state: McpState, id: Value, params: Option<Value>, base_url: Option<String>) -> JsonRpcResponse {
    let params = params.unwrap_or(json!({}));
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");

    match tool_name {
        "get_recent_photos" => call_get_recent_photos(state, id, &params, base_url),
        _ => JsonRpcResponse::error(id, -32602, format!("Unknown tool: {tool_name}")),
    }
}

fn call_get_recent_photos(state: McpState, id: Value, params: &Value, base_url: Option<String>) -> JsonRpcResponse {
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(20).min(50).max(1);
    let pet_id = args.get("pet_id").and_then(|v| v.as_str()).map(String::from);

    let filter = PhotoFilter {
        is_valid: Some(true),
        pet_id: pet_id.filter(|s| !s.is_empty()),
        limit: Some(limit),
        ..Default::default()
    };

    let store = state.store.lock().unwrap();
    match store.list(&filter) {
        Ok((photos, total)) => {
            let mut lines = vec![format!("{} photos (total {total}):", photos.len())];
            for photo in &photos {
                let caption = photo.caption.as_deref().unwrap_or("");
                let pet = photo.pet_id.as_deref().unwrap_or("?");
                let behavior = photo.behavior.as_deref().unwrap_or("?");
                let ts = photo.captured_at.format("%Y-%m-%d %H:%M");
                let url = match &base_url {
                    Some(base) => format!("{}/mcp/photos/{}", base.trim_end_matches('/'), photo.id),
                    None => format!("/mcp/photos/{}", photo.id),
                };
                lines.push(format!(
                    "#{} | {} | {} | {} | \"{}\" | {}",
                    photo.id, ts, pet, behavior, caption, url
                ));
            }
            let text = lines.join("\n");
            JsonRpcResponse::success(id, json!({
                "content": [{"type": "text", "text": text}]
            }))
        }
        Err(e) => JsonRpcResponse::error(id, -32603, format!("DB error: {e}")),
    }
}

// --- Photo download endpoint ---

pub async fn handle_mcp_photo_download(
    State(state): State<McpState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let filename = {
        let store = state.store.lock().unwrap();
        match store.get_by_id(id) {
            Ok(Some(photo)) => photo.filename,
            Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))).into_response(),
        }
    };

    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = state.photos_dir.join(&safe_name);

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
        ).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post};
    use axum::Router;
    use chrono::NaiveDate;
    use tower::util::ServiceExt;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, s).unwrap()
    }

    fn test_state() -> McpState {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let td = tempfile::tempdir().unwrap();
        let photos_dir = td.path().to_path_buf();
        std::mem::forget(td);
        McpState {
            store: Arc::new(Mutex::new(store)),
            photos_dir,
            base_url: None,
            is_tls: false,
        }
    }

    fn test_router(state: McpState) -> Router {
        Router::new()
            .route("/mcp", post(handle_mcp))
            .route("/mcp/photos/{id}", get(handle_mcp_photo_download))
            .with_state(state)
    }

    async fn post_jsonrpc(app: Router, body: Value) -> serde_json::Value {
        let resp = app
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
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn mcp_initialize() {
        let app = test_router(test_state());
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "id": 1,
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"}
            }
        })).await;
        assert_eq!(resp["result"]["serverInfo"]["name"], "pet-album-mcp");
        assert_eq!(resp["id"], 1);
    }

    #[tokio::test]
    async fn mcp_notification_returns_202() {
        let state = test_state();
        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized"
                    })).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn mcp_tools_list() {
        let app = test_router(test_state());
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "tools/list",
            "id": 2
        })).await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "get_recent_photos");
    }

    #[tokio::test]
    async fn mcp_get_recent_photos() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
            store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), Some("mike")).unwrap();
            store.update_vlm_result("a.jpg", true, "Chatora resting", "resting").unwrap();
            store.update_vlm_result("b.jpg", true, "Mike playing", "playing").unwrap();
        }
        let app = test_router(state);
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "id": 3,
            "params": {
                "name": "get_recent_photos",
                "arguments": {"limit": 5}
            }
        })).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("2 photos"));
        assert!(text.contains("chatora"));
        assert!(text.contains("mike"));
        assert!(text.contains("Chatora resting"));
        assert!(text.contains("/mcp/photos/"));
    }

    #[tokio::test]
    async fn mcp_get_recent_photos_filter_pet() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
            store.insert("b.jpg", dt(2026, 3, 21, 11, 0, 0), Some("mike")).unwrap();
            store.update_vlm_result("a.jpg", true, "cap a", "resting").unwrap();
            store.update_vlm_result("b.jpg", true, "cap b", "playing").unwrap();
        }
        let app = test_router(state);
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "id": 4,
            "params": {
                "name": "get_recent_photos",
                "arguments": {"pet_id": "chatora"}
            }
        })).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("1 photos"));
        assert!(text.contains("chatora"));
        assert!(!text.contains("mike"));
    }

    #[tokio::test]
    async fn mcp_photo_download() {
        let state = test_state();
        let photo_data = b"fake jpeg data";
        std::fs::write(state.photos_dir.join("a.jpg"), photo_data).unwrap();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
        }
        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/mcp/photos/1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], photo_data);
    }

    #[tokio::test]
    async fn mcp_photo_download_not_found() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/mcp/photos/999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mcp_unknown_method() {
        let app = test_router(test_state());
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "unknown/method",
            "id": 99
        })).await;
        assert!(resp["error"]["message"].as_str().unwrap().contains("Method not found"));
    }

    #[tokio::test]
    async fn mcp_unknown_tool() {
        let app = test_router(test_state());
        let resp = post_jsonrpc(app, json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "id": 10,
            "params": {"name": "nonexistent_tool", "arguments": {}}
        })).await;
        assert!(resp["error"]["message"].as_str().unwrap().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn mcp_photos_url_from_host_header() {
        let state = test_state();
        {
            let store = state.store.lock().unwrap();
            store.insert("a.jpg", dt(2026, 3, 21, 10, 0, 0), Some("chatora")).unwrap();
            store.update_vlm_result("a.jpg", true, "cap", "resting").unwrap();
        }
        let app = test_router(state);
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "id": 1,
            "params": {"name": "get_recent_photos", "arguments": {"limit": 1}}
        })).unwrap();
        let resp = app
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
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let resp: Value = serde_json::from_slice(&bytes).unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("http://example.com:8082/mcp/photos/"));
    }
}
