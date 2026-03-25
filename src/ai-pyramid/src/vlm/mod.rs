use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

const VLM_PROMPT: &str = r#"Analyze this photo of a pet camera feed. Respond with valid JSON only, no markdown.
{"is_valid": true if a cat is clearly visible else false,
 "caption": "one sentence describing the cat's appearance and action",
 "behavior": one of "eating","drinking","sleeping","playing","resting","moving","grooming","other"}"#;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct VlmResponse {
    pub is_valid: bool,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub behavior: String,
}

pub fn parse_vlm_response(raw: &str) -> Result<VlmResponse, String> {
    let text = raw.trim();
    // Strip markdown fences if present
    let json_str = if text.starts_with("```") {
        let inner = text
            .strip_prefix("```json")
            .or_else(|| text.strip_prefix("```"))
            .unwrap_or(text);
        inner.strip_suffix("```").unwrap_or(inner).trim()
    } else {
        text
    };

    serde_json::from_str(json_str).map_err(|e| format!("JSON parse error: {e}, raw: {raw}"))
}

const DAY_SUMMARY_PROMPT: &str = "Summarize this cat's day based on these timestamped observations. Describe activity patterns and notable moments in 2-3 sentences. Respond in plain Japanese text, no JSON.";

#[derive(Debug, Clone)]
pub struct VlmConfig {
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    pub timeout: Duration,
}

impl Default for VlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:8000".into(),
            model: "AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4-C256-P3584-CTX4095".into(),
            max_tokens: 128,
            timeout: Duration::from_secs(30),
        }
    }
}

pub struct VlmClient {
    config: VlmConfig,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: Vec<ContentPart>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ContentPart {
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlData },
    #[serde(rename = "text")]
    Text { text: String },
}

#[derive(Serialize)]
struct ImageUrlData {
    url: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    content: String,
}

/// Resize a JPEG to target dimensions and return a data URL with base64 encoding.
/// Writes directly into a pre-allocated String to minimize copies.
fn encode_resized_jpeg(path: &Path, w: u32, h: u32) -> Result<String, String> {
    let img = image::open(path).map_err(|e| format!("image open {}: {e}", path.display()))?;
    let resized = img.resize_exact(w, h, image::imageops::FilterType::Triangle);
    let mut jpeg_buf = Cursor::new(Vec::with_capacity(32 * 1024));
    resized
        .write_to(&mut jpeg_buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    let jpeg_bytes = jpeg_buf.into_inner();

    // Build data URL in one allocation
    let b64_len = jpeg_bytes.len().div_ceil(3) * 4;
    let mut url = String::with_capacity("data:image/jpeg;base64,".len() + b64_len);
    url.push_str("data:image/jpeg;base64,");
    base64::engine::general_purpose::STANDARD.encode_string(&jpeg_bytes, &mut url);
    Ok(url)
}

impl VlmClient {
    pub fn new(config: VlmConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("failed to build HTTP client");
        Self { config, http }
    }

    pub async fn analyze(&self, jpeg_path: &Path) -> Result<VlmResponse, String> {
        // VLM vision encoder uses 384×384 — resize before encoding to save memory & bandwidth.
        // Comic images are 848×496 (~100-300KB) → 384×384 JPEG (~15-30KB).
        let data_url = encode_resized_jpeg(jpeg_path, 384, 384)?;

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages: vec![Message {
                role: "user".into(),
                content: vec![
                    ContentPart::ImageUrl {
                        image_url: ImageUrlData { url: data_url },
                    },
                    ContentPart::Text {
                        text: VLM_PROMPT.into(),
                    },
                ],
            }],
            max_tokens: self.config.max_tokens,
            temperature: 0.1,
        };

        let url = format!("{}/v1/chat/completions", self.config.base_url);

        // Single retry for transient errors (known ax-llm NoneType issue)
        let mut last_err = String::new();
        for attempt in 0..2 {
            match self.http.post(&url).json(&request).send().await {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        let status = resp.status();
                        let body = resp.text().await.unwrap_or_default();
                        last_err = format!("VLM API {status}: {body}");
                        if attempt == 0 {
                            continue;
                        }
                        return Err(last_err);
                    }
                    let chat_resp: ChatResponse = resp
                        .json()
                        .await
                        .map_err(|e| format!("VLM response decode: {e}"))?;

                    let content = chat_resp
                        .choices
                        .first()
                        .map(|c| c.message.content.as_str())
                        .unwrap_or("");

                    return parse_vlm_response(content);
                }
                Err(e) => {
                    last_err = format!("VLM request failed: {e}");
                    if attempt == 0 {
                        continue;
                    }
                }
            }
        }
        Err(last_err)
    }

    /// Summarize a day's observations, optionally with a representative photo.
    pub async fn summarize_day(
        &self,
        captions: &[String],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        // Limit to most recent 50 captions to stay within 3,584 token context
        let recent: &[String] = if captions.len() > 50 {
            &captions[captions.len() - 50..]
        } else {
            captions
        };
        let observations = recent.join("\n- ");
        let user_text = format!("Observations:\n- {observations}\n\n{DAY_SUMMARY_PROMPT}");

        let mut content = Vec::new();
        if let Some(path) = photo_path
            && let Ok(data_url) = encode_resized_jpeg(path, 384, 384)
        {
            content.push(ContentPart::ImageUrl {
                image_url: ImageUrlData { url: data_url },
            });
        }
        content.push(ContentPart::Text { text: user_text });

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages: vec![Message {
                role: "user".into(),
                content,
            }],
            max_tokens: 256,
            temperature: 0.3,
        };

        let url = format!("{}/v1/chat/completions", self.config.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("VLM request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("VLM API {status}: {body}"));
        }

        let chat_resp: ChatResponse = resp
            .json()
            .await
            .map_err(|e| format!("VLM response decode: {e}"))?;

        Ok(chat_resp
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_with_whitespace() {
        let raw =
            "  \n  {\"is_valid\": true, \"caption\": \"cat\", \"behavior\": \"eating\"}  \n  ";
        let resp = parse_vlm_response(raw).unwrap();
        assert!(resp.is_valid);
    }

    #[tokio::test]
    async fn client_with_mock_server() {
        use axum::{Json, Router, routing::post};
        use std::io::Write;

        // Create a valid 1x1 JPEG using image crate
        let tmp = tempfile::Builder::new().suffix(".jpg").tempfile().unwrap();
        let img = image::RgbImage::new(1, 1);
        img.save(tmp.path()).unwrap();

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
}
