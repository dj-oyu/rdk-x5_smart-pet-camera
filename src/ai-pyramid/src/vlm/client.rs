use super::observations::{Observation, select_observations};
use super::parser::{VlmResponse, parse_vlm_response, strip_arabic, strip_think};
use super::supervisor::{systemctl, wait_for_model};
use super::{VlmConfig, VlmSwapConfig};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
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
    /// `day` must be ordered by capture time (see
    /// `PhotoStore::observations_for_date`). Only a spread-out subset is sent
    /// — see `select_observations` — and each line is prefixed with its `HH:MM`
    /// so the model sees the timeline that the system prompt's "observations
    /// only" rule refers to.
    pub async fn summarize_day(
        &self,
        day: &[Observation],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        let selected = select_observations(day, DAY_SUMMARY_OBS_LIMIT);
        let n = selected.len();
        let observations = selected
            .iter()
            // The model reads these as the household's clock, so render local
            // time even though the value is stored in UTC.
            .map(|o| {
                format!(
                    "- {} {}",
                    o.captured_at.with_timezone(&chrono::Local).format("%H:%M"),
                    o.caption
                )
            })
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
        // Per-request override of the client-level captioning timeout: this
        // single call carries a whole day of observations, so it needs a far
        // longer budget than one 384x384 frame does.
        let resp = self
            .http
            .post(&url)
            .timeout(self.config.summary_timeout)
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
        day: &[Observation],
        photo_path: Option<&Path>,
    ) -> Result<String, String> {
        info!(
            unit = swap.vision_unit.as_str(),
            "vlm swap: stopping vision model"
        );
        systemctl(&["stop", &swap.vision_unit]).await?;

        let result = self.run_on_text_model(swap, day, photo_path).await;

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
        day: &[Observation],
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
        let summary_result = text_client.summarize_day(day, photo_path).await;

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
