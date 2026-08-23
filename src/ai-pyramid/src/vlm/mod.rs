use std::time::Duration;

mod client;
mod parser;
mod supervisor;

pub use client::VlmClient;
pub use parser::{VlmResponse, parse_vlm_response};

#[cfg(test)]
use parser::strip_think;
#[cfg(test)]
use supervisor::wait_for_model;

#[derive(Debug, Clone)]
pub struct VlmConfig {
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    /// Per-photo captioning timeout. One 384x384 frame takes ~5-6s on the
    /// AX650 with Qwen3.5-2B, so 30s is generous for that path.
    pub timeout: Duration,
    /// Daily summary timeout. The summary sends up to `DAY_SUMMARY_OBS_LIMIT`
    /// observations (plus a photo) in one request, which measured ~11s on an
    /// idle NPU but exceeds the captioning timeout when the device is busy —
    /// and a timeout there is surfaced to the UI as the summary text.
    pub summary_timeout: Duration,
}

impl Default for VlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:8000".into(),
            model: "AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4-C256-P3584-CTX4095".into(),
            max_tokens: 128,
            timeout: Duration::from_secs(30),
            summary_timeout: Duration::from_secs(120),
        }
    }
}

/// Optional configuration for swapping the active axllm-serve model during a
/// single inference call. The AX650 NPU is exclusive (one axllm process at a
/// time, see `docs/ai-pyramid` notes), so the swap stops the vision unit,
/// starts the text unit, runs inference against `text_model`, then restores
/// the vision unit. Used by daily summary so we can borrow Gemma's clean
/// Japanese while keeping Qwen as the captioning workhorse.
/// `vision_*` names the multimodal model that serves per-photo captioning
/// the rest of the day; `text_*` names the text-only model invoked once for
/// the daily summary.
#[derive(Debug, Clone)]
pub struct VlmSwapConfig {
    pub vision_unit: String,
    pub text_unit: String,
    pub text_model: String,
    pub ready_timeout: Duration,
    pub poll_interval: Duration,
}
#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg_fixture() -> tempfile::NamedTempFile {
        let tmp = tempfile::Builder::new().suffix(".jpg").tempfile().unwrap();
        image::RgbImage::new(1, 1).save(tmp.path()).unwrap();
        tmp
    }

    #[test]
    fn parse_valid_json() {
        let raw = r#"{"is_valid": true, "caption": "A tabby cat resting on a wall", "behavior": "resting"}"#;
        let resp = parse_vlm_response(raw).unwrap();
        assert!(resp.is_valid);
        assert_eq!(resp.caption, "A tabby cat resting on a wall");
        assert_eq!(resp.behavior, "resting");
    }

    #[test]
    fn parse_with_markdown_fences() {
        let raw = "```json\n{\"is_valid\": false, \"caption\": \"\", \"behavior\": \"other\"}\n```";
        let resp = parse_vlm_response(raw).unwrap();
        assert!(!resp.is_valid);
    }

    #[test]
    fn parse_missing_optional_fields() {
        let raw = r#"{"is_valid": true}"#;
        let resp = parse_vlm_response(raw).unwrap();
        assert!(resp.is_valid);
        assert_eq!(resp.caption, "");
        assert_eq!(resp.behavior, "");
    }

    #[test]
    fn parse_invalid_json() {
        let raw = "not json at all";
        assert!(parse_vlm_response(raw).is_err());
    }

    #[test]
    fn parse_with_think_wrapper() {
        let raw = "<think>\n\n</think>\n\n{\"is_valid\": true, \"caption\": \"cat eating\", \"behavior\": \"eating\"}";
        let resp = parse_vlm_response(raw).unwrap();
        assert!(resp.is_valid);
        assert_eq!(resp.behavior, "eating");
    }

    #[test]
    fn parse_with_think_and_fences() {
        let raw = "<think>\nThinking...\n</think>\n\n```json\n{\"is_valid\": false, \"caption\": \"no cat\", \"behavior\": \"other\"}\n```";
        let resp = parse_vlm_response(raw).unwrap();
        assert!(!resp.is_valid);
        assert_eq!(resp.behavior, "other");
    }

    #[test]
    fn parse_with_whitespace() {
        let raw =
            "  \n  {\"is_valid\": true, \"caption\": \"cat\", \"behavior\": \"eating\"}  \n  ";
        let resp = parse_vlm_response(raw).unwrap();
        assert!(resp.is_valid);
    }

    #[test]
    fn strip_think_removes_well_formed_block() {
        let raw = "<think>internal reasoning</think>\n猫はテーブルで食事をしていました。";
        assert_eq!(strip_think(raw), "猫はテーブルで食事をしていました。");
    }

    #[test]
    fn strip_think_handles_unterminated_block() {
        // If the assistant produces an opening <think> but the response gets
        // truncated before the closer, drop everything after the opener so we
        // never surface raw reasoning to the user.
        let raw = "前置き<think>unterminated reasoning that never closes";
        assert_eq!(strip_think(raw), "前置き");
    }

    #[test]
    fn strip_think_passes_through_clean_text() {
        let raw = "猫は窓辺で日向ぼっこをしていました。";
        assert_eq!(strip_think(raw), "猫は窓辺で日向ぼっこをしていました。");
    }

    #[test]
    fn strip_think_handles_multiple_blocks() {
        let raw = "<think>a</think>あ<think>b</think>い";
        assert_eq!(strip_think(raw), "あい");
    }

    #[tokio::test]
    async fn client_with_mock_server() {
        use axum::{Json, Router, routing::post};

        let tmp = jpeg_fixture();

        // Mock VLM API using axum
        let app = Router::new().route("/v1/chat/completions", post(|| async {
            Json(serde_json::json!({
                "choices": [{
                    "message": {
                        "content": r#"{"is_valid": true, "caption": "A ginger cat", "behavior": "resting"}"#
                    }
                }]
            }))
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let client = VlmClient::new(VlmConfig {
            base_url: format!("http://{addr}"),
            ..Default::default()
        });

        let resp = client.analyze(tmp.path()).await.unwrap();
        assert!(resp.is_valid);
        assert_eq!(resp.caption, "A ginger cat");
        assert_eq!(resp.behavior, "resting");
    }

    #[tokio::test]
    async fn analyze_retries_once_after_http_error() {
        use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = attempts.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let seen = seen.clone();
                async move {
                    if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (StatusCode::SERVICE_UNAVAILABLE, "warming up").into_response();
                    }
                    Json(serde_json::json!({
                        "choices": [{
                            "message": {
                                "content": r#"{"is_valid": true, "caption": "Recovered", "behavior": "resting"}"#
                            }
                        }]
                    }))
                    .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        let client = VlmClient::new(VlmConfig {
            base_url: format!("http://{addr}"),
            ..Default::default()
        });

        let tmp = jpeg_fixture();
        let response = client.analyze(tmp.path()).await.unwrap();

        assert_eq!(response.caption, "Recovered");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn summary_outlives_the_captioning_timeout() {
        use axum::{Json, Router, routing::post};

        // A server slower than the captioning budget but well inside the
        // summary budget: captioning must give up, the summary must not.
        async fn slow_summary() -> Json<serde_json::Value> {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Json(serde_json::json!({
                "choices": [{"message": {"content": "猫は窓辺にいました。日中は静かでした。"}}]
            }))
        }

        let app = Router::new().route("/v1/chat/completions", post(slow_summary));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let client = VlmClient::new(VlmConfig {
            base_url: format!("http://{addr}"),
            timeout: Duration::from_millis(100),
            summary_timeout: Duration::from_secs(10),
            ..Default::default()
        });

        let summary = client
            .summarize_day(&["12:00 a cat by the window".to_string()], None)
            .await
            .unwrap();
        assert_eq!(summary, "猫は窓辺にいました。日中は静かでした。");

        // Same client, captioning path: still bound by the short timeout.
        let tmp = jpeg_fixture();
        assert!(client.analyze(tmp.path()).await.is_err());
    }

    #[tokio::test]
    async fn wait_for_model_accepts_only_requested_model_id() {
        use axum::{Json, Router, routing::get};

        let app = Router::new().route(
            "/v1/models",
            get(|| async { Json(serde_json::json!({"data": [{"id": "vision-model"}]})) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        let http = reqwest::Client::new();

        wait_for_model(
            &http,
            &format!("http://{addr}"),
            "vision-model",
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        let error = wait_for_model(
            &http,
            &format!("http://{addr}"),
            "other-model",
            Duration::from_millis(10),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(error.contains("other-model"));
        assert!(error.contains("not ready"));
    }
}
