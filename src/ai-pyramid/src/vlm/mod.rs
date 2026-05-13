use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

const VLM_SYSTEM_PROMPT: &str = "You are a pet camera observer. Output one JSON object with exactly three keys: \
cat, caption, behavior. \
cat: true ONLY if a real cat (domestic feline) is clearly visible; \
false if the frame shows a dog, person, object, empty room, or no cat. \
caption: one detailed English sentence (15-25 words) describing the main subject and surroundings. \
behavior: one of EXACTLY these eight values: eating, drinking, sleeping, playing, resting, moving, grooming, other. \
If cat is false, behavior MUST be \"other\". \
CRITICAL: Every string value MUST be in double quotes. No bbox. No arrays. No markdown.";

const VLM_PROMPT: &str = "/no_think\n\
Examples:\n\
{\"cat\": true, \"caption\": \"A black-and-white tabby cat sleeps curled up on a beige sofa beside a folded blanket near a sunlit window.\", \"behavior\": \"sleeping\"}\n\
{\"cat\": false, \"caption\": \"A golden retriever stands on grass in a sunny park; no cat is present.\", \"behavior\": \"other\"}\n\
{\"cat\": false, \"caption\": \"Empty living room with a couch and TV; no animal visible.\", \"behavior\": \"other\"}\n\
{\"cat\": true, \"caption\": \"A calico cat crouches on a tile floor lapping water from a stainless steel bowl beside an open closet door.\", \"behavior\": \"drinking\"}\n\n\
Output JSON for this frame (remember: cat only true for cats, behavior must be one of the eight allowed values, all strings in double quotes):";

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct VlmResponse {
    // JSON key from Qwen3.5 is "cat"; legacy/alternate spellings accepted for forward compat.
    #[serde(
        rename = "cat",
        alias = "is_valid",
        alias = "isvalid",
        alias = "cat_visible",
        alias = "catvisible"
    )]
    pub is_valid: bool,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub behavior: String,
}

const BEHAVIOR_ENUM: [&str; 8] = [
    "eating", "drinking", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

pub fn parse_vlm_response(raw: &str) -> Result<VlmResponse, String> {
    let json_str = extract_json_object(raw)
        .ok_or_else(|| format!("JSON parse error: no JSON object found, raw: {raw}"))?;
    if let Ok(resp) = serde_json::from_str::<VlmResponse>(json_str) {
        return Ok(resp);
    }
    // Lenient fallback: Qwen3.5-2B occasionally drops the closing quote on the
    // behavior enum value (e.g. `"behavior": eating}`). Re-quote known enum
    // values and retry once before giving up.
    let mut fixed = json_str.to_string();
    let needle = r#""behavior":"#;
    for v in BEHAVIOR_ENUM {
        // simple regex-free: replace `"behavior": eating}` / `"behavior":eating` / `"behavior": eating,`
        for sep in [" ", ""] {
            for tail in ["}", ",", " "] {
                let from = format!("{needle}{sep}{v}{tail}");
                let to = format!("{needle}{sep}\"{v}\"{tail}");
                fixed = fixed.replace(&from, &to);
            }
        }
    }
    serde_json::from_str(&fixed).map_err(|e| format!("JSON parse error: {e}, raw: {raw}"))
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0
                    && let Some(s) = start
                {
                    return Some(&raw[s..=i]);
                }
            }
            _ => {}
        }
    }
    None
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
            messages: vec![
                Message {
                    role: "system".into(),
                    content: vec![ContentPart::Text {
                        text: VLM_SYSTEM_PROMPT.into(),
                    }],
                },
                Message {
                    role: "user".into(),
                    content: vec![
                        ContentPart::ImageUrl {
                            image_url: ImageUrlData { url: data_url },
                        },
                        ContentPart::Text {
                            text: VLM_PROMPT.into(),
                        },
                    ],
                },
            ],
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

    /// Analyze with detection context injected into the prompt.
    /// The detection list is appended as a hint; the strict JSON schema and
    /// few-shot examples come from VLM_SYSTEM_PROMPT / VLM_PROMPT so the
    /// model does not drift into bbox/grounding mode when given confidence-style
    /// detection text (a known Qwen3.5 failure mode).
    pub async fn analyze_with_detections(
        &self,
        jpeg_path: &Path,
        detection_context: &str,
    ) -> Result<VlmResponse, String> {
        let data_url = encode_resized_jpeg(jpeg_path, 384, 384)?;

        let user_text = format!(
            "{VLM_PROMPT}\n(YOLO hints — informational only, do not echo: {detection_context})"
        );

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages: vec![
                Message {
                    role: "system".into(),
                    content: vec![ContentPart::Text {
                        text: VLM_SYSTEM_PROMPT.into(),
                    }],
                },
                Message {
                    role: "user".into(),
                    content: vec![
                        ContentPart::ImageUrl {
                            image_url: ImageUrlData { url: data_url },
                        },
                        ContentPart::Text { text: user_text },
                    ],
                },
            ],
            max_tokens: self.config.max_tokens,
            temperature: 0.1,
        };

        let url = format!("{}/v1/chat/completions", self.config.base_url);
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

    #[tokio::test]
    async fn client_with_mock_server() {
        use axum::{Json, Router, routing::post};

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
