use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tracing::{info, warn};

const VLM_SYSTEM_PROMPT: &str = "You are a pet camera observer. Output one JSON object with exactly three keys: \
cat, caption, behavior. \
cat: true ONLY if a real cat (domestic feline) is clearly visible; \
false if the frame shows a dog, person, object, empty room, or no cat. \
caption: one detailed English sentence (15-25 words) describing the main subject and surroundings. \
Use only English letters, numbers, and standard punctuation — never Arabic, Chinese, or other non-Latin characters. \
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

const DAY_SUMMARY_SYSTEM: &str = "あなたはペットカメラの観察記録を要約するアシスタントです。\
ユーザーから、1日分の猫の観察記録（時刻付き、英語の短文）が渡されます。\
次の規則に厳密に従って、自然な日本語で要約してください。\n\
1. 出力は日本語の文 2 文のみ。箇条書き・見出し・記号・コードブロック・JSON は禁止。\n\
2. 日本語のみで書く。中国語・英語・ローマ字・アラビア文字・その他の非日本語文字を混ぜない。\n\
3. 観察記録にない時刻・行動・場所・人物・猫の名前を作らない。\n\
4. 観察が 1〜2 件のときは、パターンや傾向ではなくその場面だけを淡々と書く。\n\
5. 猫は「猫」と呼ぶ。";

const DAY_SUMMARY_USER_SUFFIX: &str = "上記の観察のみに基づき、日本語で 2 文だけ要約してください。";

const DAY_SUMMARY_OBS_LIMIT: usize = 25;

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

                    return parse_vlm_response(&strip_arabic(content));
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
                    return parse_vlm_response(&strip_arabic(content));
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
    ///
    /// Captions should already be prefixed with `HH:MM` (see
    /// `PhotoStore::captions_for_date`); we forward them verbatim so the model
    /// sees the timeline that the system prompt's "observations only" rule
    /// refers to.
    pub async fn summarize_day(
        &self,
        captions: &[String],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        let recent: &[String] = if captions.len() > DAY_SUMMARY_OBS_LIMIT {
            &captions[captions.len() - DAY_SUMMARY_OBS_LIMIT..]
        } else {
            captions
        };
        let n = recent.len();
        let observations = recent
            .iter()
            .map(|c| format!("- {c}"))
            .collect::<Vec<_>>()
            .join("\n");
        let user_text =
            format!("観察件数: {n}\n観察記録:\n{observations}\n\n{DAY_SUMMARY_USER_SUFFIX}");

        let mut user_content = Vec::new();
        if let Some(path) = photo_path
            && let Ok(data_url) = encode_resized_jpeg(path, 384, 384)
        {
            user_content.push(ContentPart::ImageUrl {
                image_url: ImageUrlData { url: data_url },
            });
        }
        user_content.push(ContentPart::Text { text: user_text });

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages: vec![
                Message {
                    role: "system".into(),
                    content: vec![ContentPart::Text {
                        text: DAY_SUMMARY_SYSTEM.into(),
                    }],
                },
                Message {
                    role: "user".into(),
                    content: user_content,
                },
            ],
            max_tokens: self.config.max_tokens,
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
            .map(|c| strip_arabic(&strip_think(&c.message.content)))
            .unwrap_or_default())
    }

    /// Run `summarize_day` against the text-only axllm model named in `swap`,
    /// stopping/starting the systemd units so only one axllm process talks to
    /// the NPU at a time (AX650 exclusivity). The vision unit is always
    /// restored before returning, even when the text-model path fails.
    ///
    /// Callers MUST hold the NPU semaphore for the entire call — otherwise
    /// the per-photo watcher would issue YOLO/VLM requests against an axllm
    /// service that is mid-swap.
    pub async fn summarize_day_with_swap(
        &self,
        swap: &VlmSwapConfig,
        captions: &[String],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        info!(
            unit = swap.vision_unit.as_str(),
            "vlm swap: stopping vision model"
        );
        systemctl(&["stop", &swap.vision_unit]).await?;

        let result = self.run_on_text_model(swap, captions, photo_path).await;

        info!(
            unit = swap.vision_unit.as_str(),
            "vlm swap: restoring vision model"
        );
        let start_result = systemctl(&["start", &swap.vision_unit]).await;
        if let Err(ref e) = start_result {
            warn!(error = %e, "vlm swap: failed to start vision unit");
        }
        let wait_result = wait_for_model(
            &self.http,
            &self.config.base_url,
            &self.config.model,
            swap.ready_timeout,
            swap.poll_interval,
        )
        .await;
        if let Err(ref e) = wait_result {
            warn!(error = %e, model = self.config.model.as_str(), "vlm swap: vision model not ready after restore");
        }

        // If both restore steps fail, per-photo captioning is now broken until
        // someone intervenes — surface that instead of silently returning the
        // summary. A single failure may be transient (start raced, wait timed
        // out on slow load) so we still return the summary in that case.
        if start_result.is_err() && wait_result.is_err() {
            return Err(format!(
                "vision axllm did not recover after swap; per-photo captioning is offline. start: {} / wait: {}",
                start_result.err().unwrap_or_default(),
                wait_result.err().unwrap_or_default(),
            ));
        }

        result
    }

    async fn run_on_text_model(
        &self,
        swap: &VlmSwapConfig,
        captions: &[String],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        info!(
            unit = swap.text_unit.as_str(),
            "vlm swap: starting text model"
        );
        systemctl(&["start", &swap.text_unit]).await?;
        wait_for_model(
            &self.http,
            &self.config.base_url,
            &swap.text_model,
            swap.ready_timeout,
            swap.poll_interval,
        )
        .await?;

        let text_client = VlmClient {
            config: VlmConfig {
                model: swap.text_model.clone(),
                ..self.config.clone()
            },
            http: self.http.clone(),
        };
        let summary_result = text_client.summarize_day(captions, photo_path).await;

        // Stop the text model regardless of summary outcome so the vision
        // model can take back the NPU. We never want both axllm units running.
        info!(
            unit = swap.text_unit.as_str(),
            "vlm swap: stopping text model"
        );
        if let Err(e) = systemctl(&["stop", &swap.text_unit]).await {
            warn!(error = %e, "vlm swap: failed to stop text unit");
        }

        summary_result
    }
}

/// Run `systemctl <args...>` as the current user. pet-album is deployed as a
/// root unit, so no sudo is required; the binary just needs PATH to include
/// /usr/bin (which it does under systemd).
async fn systemctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("systemctl {args:?} spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "systemctl {args:?} exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(())
}

/// Poll `<base_url>/v1/models` until an entry whose `id` equals `model_id`
/// appears, or the timeout elapses.
async fn wait_for_model(
    http: &reqwest::Client,
    base_url: &str,
    model_id: &str,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<(), String> {
    let url = format!("{base_url}/v1/models");
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(resp) = http.get(&url).send().await
            && resp.status().is_success()
            && let Ok(body) = resp.json::<ModelsResponse>().await
            && body.data.iter().any(|m| m.id == model_id)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "model {model_id} not ready within {:?} via {url}",
                timeout
            ));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// Remove Arabic Unicode block characters (U+0600–U+06FF) injected by
/// GPTQ Int4 token degradation in Qwen3.5-2B.
fn strip_arabic(text: &str) -> String {
    text.chars()
        .filter(|&c| !('\u{0600}'..='\u{06FF}').contains(&c))
        .collect()
}

/// Remove `<think>...</think>` blocks (Qwen3.5 reasoning models leak these
/// into the assistant message when prompts don't fully suppress them).
fn strip_think(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => {
                rest = &rest[start + end + "</think>".len()..];
            }
            None => {
                // Unterminated think block — drop everything after the opener.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
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
        use axum::{
            Json, Router,
            http::StatusCode,
            response::IntoResponse,
            routing::post,
        };
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
